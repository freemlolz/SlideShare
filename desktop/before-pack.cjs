const { Arch } = require('builder-util');

module.exports = async ({ arch }) => {
  const target = Arch[arch];
  if (process.platform !== 'darwin' || target !== process.arch) {
    throw new Error(`Build ${target} on a matching Mac with a fresh npm ci. Cross-architecture packaging is disabled until native canvas is staged and tested.`);
  }
  require.resolve(`@napi-rs/canvas-darwin-${target}`);
};
