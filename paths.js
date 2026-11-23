// Where the programs and models that ship with the app are.
//
// In the installed app the code sits inside one archive file (app.asar).
// Programs cannot be started from inside an archive and models cannot be read
// from it by the libraries that use them, so the installer keeps those beside
// the archive in "app.asar.unpacked". While developing there is no archive and
// the replacement below changes nothing.
const path = require('node:path');

const root = __dirname.replace('app.asar', 'app.asar.unpacked');

module.exports = {
  // Reads and cuts video and sound.
  ffmpeg: require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked'),
  // Recognises laughs, screams, shouts, speech and music.
  soundModel: path.join(root, 'models', 'yamnet.onnx'),
  // Turns speech into text (whisper.cpp). The transcript is only offered
  // when this program is there.
  whisper: path.join(root, 'tools', 'whisper', 'whisper-cli.exe'),
};
