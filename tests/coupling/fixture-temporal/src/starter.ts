export interface Starter {
  start(type: string, workflowId: string): Promise<void>;
}

export interface Listing {
  start(name: string): void;
}

export async function throughStarter(starter: Starter): Promise<void> {
  await starter.start('OtherWorkflow', 'w');
}

export function throughListing(listing: Listing): void {
  listing.start('DemoWorkflow');
}

export interface Removal {
  workflowType?: string | undefined;
  starter: Starter;
}

export async function removeWith(deps: Removal): Promise<void> {
  await deps.starter.start(deps.workflowType ?? 'DemoWorkflow', 'r');
}

export const removeAtRoot = (starter: Starter): Promise<void> => removeWith({ starter, workflowType: 'OtherWorkflow' });
