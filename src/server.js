var
  http = require('http'),
  fs = require('fs'),
  qs = require('querystring'),
  exec = require('child_process').exec,
  url = require('url'),
  multiparty = require('multiparty'),
  spawn = require('child_process').spawn,
  shell = require('shelljs');

/* Global objects */
var networks        = {};
var report_err      = '';
var has_unreported  = false;
var status_msg      = '';

var site = __dirname + '/public';
var urlobj;
var injectStatusAfter = '<!-- errors will go here -->';

var supportedExtensions = {
  "css"   : "text/css",
  "xml"   : "text/xml",
  "htm"   : "text/html",
  "html"  : "text/html",
  "js"    : "application/javascript",
  "json"  : "application/json",
  "txt"   : "text/plain",
  "bmp"   : "image/bmp",
  "gif"   : "image/gif",
  "jpeg"  : "image/jpeg",
  "jpg"   : "image/jpeg",
  "png"   : "image/png"
};

var WHITELIST_API = {
  '/networks': true,
  '/connect': true,
  '/message': true,
  '/scan': true
};

var WHITELIST_PATHS = {
  "/index.html": true,
  "/": true,
  "/scan.html": true,
  "/status.html": true,
  "/main.css": true,
  "/logo-intel.png": true,
  "/feedbacklib.js": true
};

function getContentType(filename) {
  var i = filename.lastIndexOf('.');
  if (i < 0) {
    return 'application/octet-stream';
  }
  return supportedExtensions[filename.substr(i+1).toLowerCase()] || 'application/octet-stream';
}

function injectStatus(in_text, statusmsg, iserr) {
  var injectStatusAt = in_text.indexOf(injectStatusAfter) + injectStatusAfter.length;
  var status = "";
  if (statusmsg) {
    if (iserr)
      status = '<div id="statusarea" name="statusarea" class="status errmsg">' + statusmsg + '</div>';
    else
      status = '<div id="statusarea" name="statusarea" class="status">' + statusmsg + '</div>';
  }
  return in_text.substring(0, injectStatusAt) + status + in_text.substring(injectStatusAt, in_text.length);
}

function inject(my_text, after_string, in_text) {
  var at = in_text.indexOf(after_string) + after_string.length;
  return in_text.substring(0, at) + my_text + in_text.substring(at, in_text.length);
}

function pageNotFound(res) {
  res.statusCode = 404;
  res.end("404 Not Found");
}

/* determines if a requested path is
 * whitelisted
 */
function is_wl(path) {
  return (is_wl_api(path) || is_wl_fpath(path));
}

/* determines if a requested path is
 * a whitelisted api path
 */
function is_wl_api(path) {
  var ret = false;

  if (path) {
    ret = WHITELIST_API[path];
  }

  return ret;
}

/* determines if a requested path is
 * a whitelisted file path
 */
function is_wl_fpath(path) {
  var ret = false;

  if (path) {
    ret = WHITELIST_PATHS[path];
  }

  return ret;
}

/* handle_status handles a particular page (status.html) */
function handle_status(page, res) {
  var mode  = shell.exec('configure_tage --mode', { silent: true });
  var host  = 'N/A';
  var lstr  = 'N/A';
  var tstr  = 'N/A';
  var sstr  = 'N/A';
  var l_ip  = null;
  var t_ip  = null;
  var ssid  = null;

  /* if we're not in hostapd mode, grab interweb details */
  if (mode.stdout.trim() !== 'Master') {
    l_ip  = shell.exec('configure_tage --local-ip', { silent: true });
    t_ip  = shell.exec('configure_tage --tun-ip', { silent: true });
    ssid  = shell.exec('configure_tage --curr-ssid', { silent: true });

    /* If the string isn't empty, assign */
    if (l_ip.stdout.trim() != '') {
      lstr = l_ip.stdout.trim();
    }

    if (t_ip.stdout.trim() != '') {
      tstr = t_ip.stdout.trim();
    }

    if (ssid.stdout.trim() != '') {
      sstr = ssid.stdout.trim();
    }
  }

  /* grab our hostname */
  exec('hostname', function (err, stdout, stderr) {

    if (err) {
      console.log('executing the command "hostname" resulted in error ' + stderr);
    } else {
      host = stdout;
    }

    /* modify the page on the fly */
    page = page.replace(/params_ip/g, lstr)
    page = page.replace(/params_hostname/g, host);
    page = page.replace(/params_tunnel_ip/g, tstr);
    page = page.replace(/params_ssid/g, sstr);

    /* send */
    res.end(page)
  });
}

/* handles index page & error reports */
function handle_index(page, res) {
  if (has_unreported) {
    page = injectStatus(page, report_err, true);
    has_unreported = false;
  }

  res.end(page);
}

/* ensures provided parameters are acceptable and
 * returns formatted arguments for exec
 */
function verify_wifi_params(params) {
  var ret = { succ: true,
    msg: '',
    args: [ '--wifi', '--proto', params.protocol, '--ssid', '"' + params.newwifi + '"' ]
  };

  if (!params || !params.newwifi || !params.protocol) {
    ret.msg   = 'Invalid parameters provided to verify_wifi_params';
    ret.succ  = false;
  } else if (!params.protocol !== 'OPEN' && !params.netpass) {
    ret.msg   = 'Protocol requires a password be provided.';
    ret.succ  = false;
  } else if (params.protocol === 'WEP') {
    if (params.netpass.length != 5 || params.netpass.length != 13) {
      ret.msg   = 'Protocol requires a password length of either 5 or 13.';
      ret.succ  = false;
    } else {
      ret.args.push( '--psk',  '"' + params.netpass + '"');
    }
  } else if (params.protocol === "WPA-PSK") {
    if (params.netpass.length < 8 || params.netpass.length > 63) {
      ret.msg   = 'Protocol requires a password length between 8 and 63.';
      ret.succ  = false;
    } else {
      ret.args.push( '--psk',  '"' + params.netpass + '"');
    }
  } else if (params.protocol === "WPA-EAP") {
    if (!params.netuser) {
      ret.msg   = "Protocol requires a username be provided.";
      ret.succ  = false;
    } else {
      ret.args.push('--psk', '"' + params.netpass + '"', '--identity', '"' + params.netuser + '"');
    }
  }

  return ret;
}

/* returns the index with an error */
function on_error_index(res, error) {
  var page = fs.readFileSync(site + '/index.html', { encoding: 'utf8' });

  res.end(injectStatus(page, error, true));
}

function on_succ_exit(res, params) {
  var page = fs.readFileSync(site + '/exit.html', { encoding: 'utf8' });

  exec('hostname', function (err, stdout, stderr) {
    if (err) {
      console.log(stderr);
    } else {
      page = page.replace(/params_new_wifi/g, params.newwifi ? params.newwifi : "");
      page = page.replace(/params_hostname/g, stdout.trim() + '.local');
      page = page.replace(/params_ssid/g, params.newwifi);
      page = page.replace(/params_curr_ssid/g, params.newwifi);

      res.end(page);
    }
  });
}

/* handles connection api */
function handle_connect(res, params) {
  var verify  = verify_wifi_params(params);

  if (verify.succ == true) {
    status_msg = "Connecting to wireless network " + params.newwifi;
    on_succ_exit(res, params); /* send them to leaving setup page */

    exec('sleep 2', function (err, stdout, stderr) {
      console.log('Attempting to connect to network ' + params.newwifi);

      exec('configure_tage ' + verify.args.join(' '), function (err, stdout, stderr) {
        if (err) {
          has_unreported  = true;
          report_err      = stderr;
          status_msg      = 'Failed to connect to wireless network!';

          console.log('Attempting to connect to wireless network failed with ' + stderr);
        } else {
          exec('sleep 2 && systemctl restart mdns', { silent: true });
          status_msg      = 'Connected to wireless network!';
          console.log(status_msg);

          /* create persistent environment */
          console.log('Creating persistent environment');
          exec('configure_tage --persist', function (err, stdout, stderr) {
            if (err) {
              has_unreported  = true;
              report_err      = "Unable to create persistent environment";

              console.log(report_err);
            } else {
              console.log('Created persistent enviroment.');
            }
          });
        }
      });
    });
  } else {
    on_error_index(res, verify.msg);
  }
}

function handle_post(req, res, path) {
  if (path === '/connect') {
    var payload = '';

    req.on('data', function (data) {
      payload += data;
    });

    req.on('end', function () {
      handle_connect(res, qs.parse(payload));
    });
  }
}

function handle_scan(req, res) {
  console.log('Network scan requested');

  /* send page prior to scan */
  res.end(fs.readFileSync(site + '/scan.html', { encoding: 'utf8' }));

  scan(function (err, nw) {
    if (err) {
      report_err = 'An error occurred when scanning for networks: ' + err;
      has_unreported = true;

      console.log('An error occurred when scanning for networks: ' + err);
    } else {
      networks = nw;

      console.log('Network scan finished.');
    }
  });
}

/* We do on-the-fly editing to avoid crazy api calls
 * on this already slow server
 */
function handle_get(req, res, path) {
  if (is_wl_fpath(path)) {
    var obj = null;
    var enc = { encoding: null };

    /* handle '/' case */
    if (path === '/') {
      path = '/index.html';
    }

    /* handle read encoding */
    if (path.indexOf('html') > -1) {
      enc.encoding = 'utf8';
    }

    /* load the object and assign content-type */
    obj = fs.readFileSync(site + path, enc);
    res.setHeader('content-type', getContentType(path));

    /* some items are specific */
    if (path === '/status.html') { /* handle status page */
      handle_status(obj, res);
    } else if (path == '/index.html') { /* handle index page */
      handle_index(obj, res);
    } else { /* all other objects */
      res.end(obj);
    }
  } else if (is_wl_api(path)) {
    if (path === '/networks') {
      res.end(JSON.stringify(networks));
    } else if (path === '/message') {
      res.end(status_msg);
    } else if (path === '/scan') {
      handle_scan(req, res);
    }
  } else { /* shouldn't be possible */
    res.statusCode(500);
    res.end('Error!');
  }
}

function handler(req, res) {
  var urlobj = url.parse(req.url, true);

  if (!is_wl(urlobj.pathname)) {
    console.log('Requested path ' + urlobj.pathname + ' not whitelisted.');
    pageNotFound(res);  /* 404 if not whitelisted */
  } else if (req.method === 'POST') {
    handle_post(req, res, urlobj.pathname);
  } else if (req.method === 'GET') {
    handle_get(req, res, urlobj.pathname);
  } else {
    res.statusCode(500);
    res.end('Unknown Method ' + req.method);
  }
}

function scan(callback) {
  exec('configure_tage --scan', function (err, stdout, stderr) {
    if (err) {
      callback(err, null);
    } else {
      var obj = {
        last_scan: Date.now(),
        networks: JSON.parse(stdout)
      };

      callback(null, obj);
    }
  });
}

/* prior to starting the server, we are going to scan for wireless */
console.log('Starting network scan prior to starting server.');
scan(function (err, nw) {
  if (err) {
    console.log('Initial call to "configure_tage --scan" resulted in error ' + err);
  } else {
    networks = nw;
    console.log(networks);

  }

  http.createServer(handler).listen(80);
  console.log('Server started on port 80.');
});
