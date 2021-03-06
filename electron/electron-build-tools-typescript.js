const typescript = require("typescript-cached-transpile");

const contentMap = new Map();

module.exports = {
  ...typescript,
  getFileContent: (filename) => contentMap.get(filename),
  createLanguageService: (
    host,
    documentRegistry,
    syntaxOnlyOrLanguageServiceMode
  ) => {
    const service = typescript.createLanguageService(
      host,
      documentRegistry,
      syntaxOnlyOrLanguageServiceMode
    );

    return {
      ...service,
      getEmitOutput: (fileName, emitOnlyDtsFiles, forceDtsEmit) => {
        const output = service.getEmitOutput(
          fileName,
          emitOnlyDtsFiles,
          forceDtsEmit
        );
        contentMap.set(filename, output.outputFiles[1].text);

        return output;
      },
    };
  },
  transpileModule: (input, transpileOptions) => {
    const output = typescript.transpileModule(input, transpileOptions);
    contentMap.set(transpileOptions.fileName, output.outputText);

    return output;
  },
};
