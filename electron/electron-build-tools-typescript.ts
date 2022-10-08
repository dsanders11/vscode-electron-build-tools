const path = require("path");

const typescript = require(path.resolve(
  __dirname,
  "..",
  "..",
  "node_modules",
  "typescript-cached-transpile"
));
import type {
  createLanguageService,
  transpileModule,
} from "typescript-cached-transpile";

type CreateLanguageServiceParameters = Parameters<typeof createLanguageService>;
type TranspileModuleParameters = Parameters<typeof transpileModule>;

const contentMap = new Map<string, string>();

module.exports = {
  ...typescript,
  getFileContent: (filename: string) => contentMap.get(filename),
  createLanguageService: (
    host: CreateLanguageServiceParameters[0],
    documentRegistry: CreateLanguageServiceParameters[1],
    syntaxOnlyOrLanguageServiceMode?: CreateLanguageServiceParameters[2]
  ) => {
    const service = (
      typescript.createLanguageService as typeof createLanguageService
    )(host, documentRegistry, syntaxOnlyOrLanguageServiceMode);

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
    const output = (typescript.transpileModule as typeof transpileModule)(
      input,
      transpileOptions
    );
    contentMap.set(transpileOptions.fileName!, output.outputText);

    return output;
  },
};
