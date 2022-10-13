import typescript from "typescript-cached-transpile";

type CreateLanguageServiceParameters = Parameters<
  typeof typescript.createLanguageService
>;
type TranspileModuleParameters = Parameters<typeof typescript.transpileModule>;

const contentMap = new Map<string, string>();

module.exports = {
  ...typescript,
  getFileContent: (filename: string) => contentMap.get(filename),
  createLanguageService: (
    host: CreateLanguageServiceParameters[0],
    documentRegistry: CreateLanguageServiceParameters[1],
    syntaxOnlyOrLanguageServiceMode?: CreateLanguageServiceParameters[2]
  ) => {
    const service = typescript.createLanguageService(
      host,
      documentRegistry,
      syntaxOnlyOrLanguageServiceMode
    );

    return {
      ...service,
      getEmitOutput: (
        fileName: string,
        emitOnlyDtsFiles?: boolean,
        forceDtsEmit?: boolean
      ) => {
        const output = service.getEmitOutput(
          fileName,
          emitOnlyDtsFiles,
          forceDtsEmit
        );
        contentMap.set(fileName, output.outputFiles[1].text);

        return output;
      },
    };
  },
  transpileModule: (
    input: TranspileModuleParameters[0],
    transpileOptions: TranspileModuleParameters[1]
  ) => {
    const output = typescript.transpileModule(input, transpileOptions);
    contentMap.set(transpileOptions.fileName!, output.outputText);

    return output;
  },
};
