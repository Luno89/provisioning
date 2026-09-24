import type { PlanProposal } from '../lib/plan-proposals.js';

export interface PlanStore {
  getPlanProposals(ownerId: string, conversationId?: string): Promise<PlanProposal[]>;
  getPlanProposal(ownerId: string, id: string): Promise<PlanProposal | undefined>;
  savePlanProposal(proposal: PlanProposal): Promise<void>;
}

export interface PlanAdopter {
  adoptPlan(ownerId: string, proposalId: string): Promise<string | undefined>;
}

export type PlanDecision =
  | { ok: true; proposal: PlanProposal }
  | { ok: false; status: 404 | 409 | 503; error: string };

const DECIDABLE: PlanProposal['status'][] = ['proposed', 'failed'];

export class PlanService {
  constructor(private readonly deps: { store: PlanStore; adopter: PlanAdopter; now?: () => string }) {}

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  list(ownerId: string, conversationId?: string): Promise<PlanProposal[]> {
    return this.deps.store.getPlanProposals(ownerId, conversationId);
  }

  get(ownerId: string, id: string): Promise<PlanProposal | undefined> {
    return this.deps.store.getPlanProposal(ownerId, id);
  }

  async approve(ownerId: string, id: string): Promise<PlanDecision> {
    const proposal = await this.deps.store.getPlanProposal(ownerId, id);
    if (!proposal) return { ok: false, status: 404, error: 'Plan not found' };
    if (!DECIDABLE.includes(proposal.status)) {
      return { ok: false, status: 409, error: `This plan is ${proposal.status}; only a proposed plan, or one whose adoption failed, can be approved.` };
    }

    const adopting: PlanProposal = { ...proposal, status: 'adopting', updatedAt: this.now() };
    delete adopting.reason;
    await this.deps.store.savePlanProposal(adopting);

    const started = await this.deps.adopter.adoptPlan(ownerId, id).catch(() => undefined);
    if (!started) {
      await this.deps.store.savePlanProposal(proposal);
      return { ok: false, status: 503, error: 'Temporal is not reachable, so the plan could not be built. It is still waiting for approval.' };
    }
    return { ok: true, proposal: adopting };
  }

  async reject(ownerId: string, id: string, reason?: string): Promise<PlanDecision> {
    const proposal = await this.deps.store.getPlanProposal(ownerId, id);
    if (!proposal) return { ok: false, status: 404, error: 'Plan not found' };
    if (!DECIDABLE.includes(proposal.status)) {
      return { ok: false, status: 409, error: `This plan is ${proposal.status}; it can no longer be rejected.` };
    }

    const rejected: PlanProposal = {
      ...proposal,
      status: 'rejected',
      ...(reason?.trim() ? { reason: reason.trim() } : {}),
      updatedAt: this.now(),
    };
    await this.deps.store.savePlanProposal(rejected);
    return { ok: true, proposal: rejected };
  }
}
