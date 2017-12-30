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
//var injectPasswordSectionAfter = 'onsubmit="saveFields()">';
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
var STATE_DIR = '/var/lib/edison_config_tools';
var NETWORKS_FILE = STATE_DIR + '/networks.txt';
var COMMAND_OUTPUT = "";
var COMMAND_OUTPUT_MAX = 3072; // bytes
// available when edison is not in AP-mode. In AP-mode, however, all commands and files are available.
// That's because AP-mode is considered somewhat more secure (credentials are derived from mac address and serial number on box)
var WHITELIST_CMDS = {
  "/commandOutput": true
};

var WHITELIST_API = {
  '/networks': true,
  '/connect': true,
  '/message': true
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
var WHITELIST_EXEC = {
  "configure_edison": true,
  "sleep": true
};

function resetCommandOutputBuffer() {
  COMMAND_OUTPUT = "";
}

function appendToCommandOutputBuffer(newoutput) {
  if (COMMAND_OUTPUT_MAX - COMMAND_OUTPUT.length >= newoutput.length) {
    COMMAND_OUTPUT += newoutput;
  }
}

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

function setWiFi(params) {
  var exec_cmd = "", errmsg = "Unknown error occurred.", exec_args=[];

  if (!params.newwifi) {
    return {cmd: ""};
  } else if (!params.protocol) {
    errmsg = "Please specify the network protocol (Open, WEP, etc.)";
  } else if (params.protocol === "OPEN") {
    exec_cmd = "configure_edison";
    exec_args.push("--changeWiFi");
    exec_args.push("OPEN");
    exec_args.push(params.newwifi);
  } else if (params.protocol === "WEP") {
    if (params.netpass.length == 5 || params.netpass.length == 13) {
      exec_cmd = "configure_edison";
      exec_args.push("--changeWiFi");
      exec_args.push("WEP");
      exec_args.push(params.newwifi);
      exec_args.push(params.netpass);
    } else {
      errmsg = "The supplied password must be 5 or 13 characters long.";
    }
  } else if (params.protocol === "WPA-PSK") {
      if (params.netpass && params.netpass.length >= 8 && params.netpass.length <= 63) {
        exec_cmd = "configure_edison";
        exec_args.push("--changeWiFi");
        exec_args.push("WPA-PSK");
        exec_args.push(params.newwifi);
        exec_args.push(params.netpass);
      } else {
        errmsg = "Password must be between 8 and 63 characters long.";
      }
  } else if (params.protocol === "WPA-EAP") {
      if (params.netuser && params.netpass) {
        exec_cmd = "configure_edison";
        exec_args.push("--changeWiFi");
        exec_args.push("WPA-EAP");
        exec_args.push(params.newwifi);
        exec_args.push(params.netuser);
        exec_args.push(params.netpass);
      } else {
        errmsg = "Please specify both the username and the password.";
      }
  } else {
    errmsg = "The specified network protocol is not supported."
  }

  if (exec_cmd) {
    return {cmd: exec_cmd, args: exec_args};
  }
  return {failure: errmsg};
}

function doSleep() {
  return { cmd: 'sleep', args: [2] };
}

function runCmd(i, commands) {
  if (i === commands.length)
    return;

  if (commands[i].cmd && !WHITELIST_EXEC[commands[i].cmd]) {
    return;
  }

  appendToCommandOutputBuffer("Executing " + commands[i].cmd + " " + commands[i].args[0] + "\n");

  commands[i].proc = spawn(commands[i].cmd, commands[i].args);

  commands[i].proc.stdout.on('data', function (data) {
    appendToCommandOutputBuffer(data);
  });

  commands[i].proc.stderr.on('data', function (data) {
    appendToCommandOutputBuffer(data);
  });

  commands[i].proc.on('close', function (code) {
    appendToCommandOutputBuffer(commands[i].cmd + " " + commands[i].args[0] + " has finished\n");
    setImmediate(runCmd, i+1, commands);
  });

  commands[i].proc.on('error', function (err) {
    appendToCommandOutputBuffer(commands[i].cmd + " " + commands[i].args[0] +
    " encountered the following error:\n" + err + "\n");
    setImmediate(runCmd, i+1, commands);
  });
}

function submitForm(params, res, req) {
  resetCommandOutputBuffer();

  //var calls = [setPass, setHost, doSleep, setWiFi];
  var calls = [doSleep, setWiFi];

  var result = null, commands = [];

  // check for errors and respond as soon as we find one
  for (var i = 0; i < calls.length; ++i) {
    result = calls[i](params, req);
    if (result.failure) {
      res.end(injectStatus(fs.readFileSync(site + '/index.html', { encoding: 'utf8' }), result.failure, true));
      return;
    }
    if (result.cmd)
      commands.push(result);
  }

  // no errors occurred. Do success response.
  exec ('configure_edison --showNames', function (error, stdout, stderr) {
    var nameobj = {hostname: "unknown", ssid: "unknown", default_ssid: "unknown"};
    try {
      nameobj = JSON.parse(stdout);
    } catch (ex) {
      console.log("Could not parse output of configure_edison --showNames (may not be valid JSON)");
      console.log(ex);
    }

    var hostname = nameobj.hostname, ssid = nameobj.ssid;
    var res_str;

    if (params.name) {
      hostname = ssid = params.name;
    }

    if (params.newwifi) { // WiFi is being configured
      res_str = fs.readFileSync(site + '/exit.html', {encoding: 'utf8'})
    } else {
      res_str = fs.readFileSync(site + '/exiting-without-wifi.html', {encoding: 'utf8'})
    }

    res_str = res_str.replace(/params_new_wifi/g, params.newwifi ? params.newwifi : "");
    res_str = res_str.replace(/params_hostname/g, hostname + ".local");
    res_str = res_str.replace(/params_ssid/g, ssid);
    res_str = res_str.replace(/params_curr_ssid/g, nameobj.ssid);
    res_str = res_str.replace(/params_curr_hostname/g, nameobj.hostname + ".local");
    res.end(res_str);

    commands.push({cmd: "configure_edison", args: ["--disableOneTimeSetup", "--persist"]});

    // Now execute the commands serially
    runCmd(0, commands);
  });
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
      exec('configure_tage ' + verify.args.join(' '), function (err, stdout, stderr) {
        if (err) {
          console.log('err!: ' + err);
          console.log('stderr!: ' + stderr);
          console.log('stdout!: ' + stdout);

          /* set the error, when they return to the site it'll be here */
          has_unreported  = true;
          report_err      = stdout;
          status_msg      = 'Failed to connect to wireless network!';
        } else {
          exec('sleep 2 && systemctl restart mdns', { silent: true });
          status_msg      = 'Connected to wireless network!';
          
          /* TODO: here we do the mdns & disable hostapd & enable wpa_supplicant */
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
    }
  } else { /* shouldn't be possible */
    res.statusCode(500);
    res.end('Error!');
  }
}

function handler(req, res) {
  var urlobj = url.parse(req.url, true);

  console.log('urlobj.pathname: ' + urlobj.pathname);

  if (!is_wl(urlobj.pathname)) {
    console.log('not whitelisted');
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

// main request handler. GET requests are handled here.
// POST requests are handled in handlePostRequest()
function requestHandler(req, res) {
  var urlobj = url.parse(req.url, true);

  if (!inWhiteList(urlobj.pathname)) {
    pageNotFound(res);
    return;
  }

  // POST request. Get payload.
  if (req.method === 'POST') {
    handlePostRequest(req, res);
    return;
  }


  // GET request
  console.log('urlobj.pathname: ' + urlobj.pathname);
  if (!urlobj.pathname || urlobj.pathname === '/' || urlobj.pathname === '/index.html') {
    res.setHeader('Access-Control-Allow-Origin', '*');


      var result = shell.exec('configure_edison --showWiFiMode', {silent:true});
    if ((result.code != 0) || (result.stdout.trim() != "Master")) {
      var res_str = fs.readFileSync(site + '/status.html', {encoding: 'utf8'});
      var myhostname, myipaddr;
      exec('configure_edison --showWiFiIP', function (error, stdout, stderr) {
        if (error) {
          console.log("Error occurred:");
          console.log(stderr);
          myipaddr = "unknown";
        } else {
          myipaddr = stdout;
        }

        exec('hostname', function (error, stdout, stderr) {
          if (error) {
            console.log("Error occurred:");
            console.log(stderr);
            myhostname = "unknown";
          } else {
            myhostname = stdout;
          }
          res_str = res_str.replace(/params_ip/g, myipaddr);
          res_str = res_str.replace(/params_hostname/g, myhostname);
          res.end(res_str);
        });
      });
    } else {
      res.end(fs.readFileSync(site + '/index.html', { encoding: 'utf8' }));
    }
  } else if (urlobj.pathname === '/wifiNetworks') {
    if (fs.existsSync(NETWORKS_FILE)) {
      res.setHeader('content-type', getContentType(NETWORKS_FILE));
      res.end(fs.readFileSync(NETWORKS_FILE, {encoding: 'utf8'}));
    } else {
      res.end("{}");
    }
  } else if (urlobj.pathname === '/commandOutput') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(COMMAND_OUTPUT);
  } else { // for files like .css and images.
    if (!fs.existsSync(site + urlobj.pathname)) {
      pageNotFound(res);
      return;
    }
    res.setHeader('content-type', getContentType(urlobj.pathname));
    res.end(fs.readFileSync(site + urlobj.pathname, {encoding: null}));
  }
}

exec('configure_edison --showNames', function (error, stdout, stderr) {
  if (error) {
    console.log("Error saving default SSID");
    console.log(error);
  }
  if (!fs.existsSync(STATE_DIR + '/upgrade.done')) {
      fs.writeFile(STATE_DIR + "/upgrade.done", "Upgrade completed.\n", function(err) {
        if(err) {
          console.log(err);
        } else {
          console.log("Upgrade status file saved");
        }
      });
      var result = shell.exec('configure_edison --isRestartWithAPSet', {silent:true});
      if ((result.code != 0) || (result.stdout.trim() === "True")) {
        exec('configure_edison --enableOneTimeSetup', function (error, stdout, stderr) {
          if (error) {
            console.log("Error starting out-of-box-experience.");
            console.log(error);
          }
        });
      }
  }
});

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
/*
exec('configure_tage --scan', function (err, stdout, stderr) {
  if (err) {
    console.log('Initial call to "configure_tage --scan" resulted in error ' + stdout);
  } else {
    networks = JSON.parse(stdout);
    console.log(stdout);
  }

  / now, start server /
  http.createServer(handler).listen(80);
  console.log("Server started on port 80.");
});
*/

//http.createServer(handler).listen(80);
//http.createServer(requestHandler).listen(80);
