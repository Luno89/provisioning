import { builtInCatalogue } from '../nodes/index.js';
import { BUILT_IN_GROUPS } from '../seeds/groups.js';
import { builderModuleDeclarations, builderTypes } from './declarations.js';

export const GENERATED_TYPES_PATH = 'src/procedure/builder/types.generated.ts';
export const GENERATED_DECLARATIONS_PATH = 'src/procedure/builder/declarations.generated.ts';

export function generatedBuilderFiles(): Record<string, string> {
  const catalogue = builtInCatalogue();
  return {
    [GENERATED_TYPES_PATH]: builderTypes(catalogue, BUILT_IN_GROUPS),
    [GENERATED_DECLARATIONS_PATH]: `export const BUILDER_DECLARATIONS = ${JSON.stringify(builderModuleDeclarations(catalogue, BUILT_IN_GROUPS))};\n`,
  };
}
