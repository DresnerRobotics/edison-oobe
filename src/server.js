var
  http = require('http'),
  fs = require('fs'),
  qs = require('querystring'),
  exec = require('child_process').exec,
  url = require('url'),
  multiparty = require('multiparty'),
  spawn = require('child_process').spawn,
  shell = require('shelljs');


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
  'networks': true
}
var WHITELIST_PATHS = {
  "/index.html": true,
  "/": true,
  "/scan.html": true,
  "/main.css": true,
  "/logo-intel.png": true
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

function handlePostRequest(req, res) {
  if (urlobj.pathname === '/submitForm') {
    var payload = "";
    req.on('data', function (data) {
      payload += data;
    });
    req.on('end', function () {
      var params = qs.parse(payload);
      submitForm(params, res, req);
    });
  } else {
    pageNotFound(res);
  }
}

function inWhiteList(path) {
  if (!path)
    return false;
  // if shell command succeeds and in host AP mode
  var result = shell.exec('configure_edison --showWiFiMode', {silent:true});
  if ((result.code != 0) || (result.stdout.trim() === "Master")) {
    return true;
  }
  return WHITELIST_PATHS[path] || WHITELIST_CMDS[path];
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
  var l_ip  = NULL;
  var t_ip  = NULL;

  /* if we're not in hostapd mode, grab interweb details */
  if (result.stdout.trim() !== 'Master') {
    l_ip = shell.exec('configure_tage --local-ip', { silent: true });
    t_ip  = shell.exec('configure_tage --tun-ip', { silent: true });

    /* If the string isn't empty, assign */
    if (l_ip.stdout.trim() != '') {
      lstr = l_ip.stdout.trim();
    }

    if (t_ip.stdout.trim() != '') {
      tstr = t_ip.stdout.trim();
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
    res_str = res_str.replace(/params_ip/g, lstr)
    res_str = res_str.replace(/params_hostname/g, host);
    res_str = res_str.replace(/params_tunnel_ip/g, tstr);

    /* send */
    res.end(res_str)
  });
}

function handle_post(req, res, path) {
  /* POST is our submit buttons */
}

/* We do on-the-fly editing to avoid crazy api calls
 * on this already slow server
 */
function handle_get(req, res, path) {
  if (is_wl_fpath(path)) {
    var page = fs.readFileSync(site + '/' + path, { encoding: 'utf8' });

    if (path === 'status.html') { /* handle status page */
      handle_status(page, res);
    }
  } else if (is_wl_api(path)) {

  } else { /* shouldn't be possible */

  }
}

function handler(req, res) {
  var urlobj = url.parse(req.url, true);


  console.log('urlobj.pathname: ' + urlobj.pathname);

  if (!is_wl(urlobj.pathname)) {
    pageNotFound(res);  /* 404 if not whitelisted */
  } else if (req.method === 'POST') {
    res.end('Okay');
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

http.createServer(handler).listen(80);
//http.createServer(requestHandler).listen(80);
