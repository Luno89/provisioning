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
