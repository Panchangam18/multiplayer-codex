const { app, BrowserWindow } = require('electron');
const path = require('node:path');
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
app.commandLine.appendSwitch('remote-debugging-port', process.env.FIXTURE_PORT);
app.setPath('userData', process.env.FIXTURE_PROFILE);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1180, height: 850, webPreferences: { backgroundThrottling: false } });
  await window.loadFile(path.join(__dirname, 'desktop.html'));
});
app.on('window-all-closed', () => app.quit());
