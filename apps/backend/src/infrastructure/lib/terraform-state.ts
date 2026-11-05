export const stateFilesOf = (stackName: string): string[] => [`terraform.${stackName}.tfstate`, `terraform.${stackName}.tfstate.backup`];
