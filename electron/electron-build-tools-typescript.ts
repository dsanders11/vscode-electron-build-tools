import typescript from "typescript-cached-transpile";

const contentMap = new Map<string, string>();

const exports: typeof typescript = {
  ...typescript,
  createLanguageService: (...args) => {
    const service = typescript.createLanguageService(...args);

    return {
      ...service,
      getEmitOutput: (fileName, emitOnlyDtsFiles?, forceDtsEmit?) => {
        const output = service.getEmitOutput(
          fileName,
          emitOnlyDtsFiles,
          forceDtsEmit,
        );
        contentMap.set(fileName, output.outputFiles[1].text);

        return output;
      },
    };
  },
  transpileModule: (input, transpileOptions) => {
    const output = typescript.transpileModule(input, transpileOptions);
    contentMap.set(transpileOptions.fileName!, output.outputText);

    return output;
  },
};

module.exports = {
  ...exports,
  getFileContent: (filename: string) => contentMap.get(filename),
};
