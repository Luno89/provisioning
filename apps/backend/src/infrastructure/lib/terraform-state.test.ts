import { describe, expect, it } from 'vitest';
import { stateFilesOf } from './terraform-state.js';

describe('the files a stack keeps its Terraform state in', () => {
  it('is the state and the backup Terraform writes beside it, named for the stack as the CDKTF app names them', () => {
    expect(stateFilesOf('provisioning-lunorica-observability')).toEqual(['terraform.provisioning-lunorica-observability.tfstate', 'terraform.provisioning-lunorica-observability.tfstate.backup']);
  });
});
