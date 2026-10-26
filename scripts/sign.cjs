// Code-signing hook for electron-builder (win.signtoolOptions.sign).
// Signs only when WINDOWS_SIGN_COMMAND is set: a command line with {file} where the
// path goes, for whichever service is chosen (e.g. signtool with a cloud HSM, SSL.com
// eSigner CodeSignTool, Certum SimplySign). Without it the build is unsigned and only
// meant for internal testing (SmartScreen and Smart App Control will warn or block).
const { execSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function sign(configuration) {
  const file = configuration.path;
  const command = process.env.WINDOWS_SIGN_COMMAND;
  if (!command) {
    console.log(`[sign] unsigned (no WINDOWS_SIGN_COMMAND): ${path.basename(file)}`);
    return;
  }
  // abap-adt-mcp.exe is node.exe with our code injected: its original Node.js
  // signature is invalid after injection and must be stripped before re-signing.
  if (/abap-adt-mcp\.exe$/i.test(file) && process.env.WINDOWS_SIGNTOOL) {
    execSync(`"${process.env.WINDOWS_SIGNTOOL}" remove /s "${file}"`, { stdio: 'inherit' });
  }
  execSync(command.replaceAll('{file}', `"${file}"`), { stdio: 'inherit' });
};
