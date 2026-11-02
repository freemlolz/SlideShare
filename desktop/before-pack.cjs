const { Arch } = require('builder-util');

module.exports = async ({ arch, electronPlatformName }) => {
  const target = Arch[arch];
  const supported = (electronPlatformName === 'darwin' && ['x64', 'arm64'].includes(target))
    || (electronPlatformName === 'win32' && target === 'x64');
  if (!supported || process.platform !== electronPlatformName || target !== process.arch) {
    throw new Error(`Build ${electronPlatformName}/${target} on a matching OS and architecture with a fresh npm ci. Supported: macOS x64/arm64 and Windows x64. Cross-platform and cross-architecture packaging are disabled.`);
  }
  const binding = electronPlatformName === 'win32' ? `win32-${target}-msvc` : `darwin-${target}`;
  require.resolve(`@napi-rs/canvas-${binding}`);
  require('@napi-rs/canvas').createCanvas(1, 1);
};
