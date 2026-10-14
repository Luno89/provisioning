import { useEffect, useMemo, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { PlanProposal } from '@koala/harness-types'
import { getTreeRun, groveKeys, listBranches, listLeaves } from '../../../api/grove'
import { listTreePlans, planKeys } from '../../../api/plans'
import { followedStories, planProgress, plansTree, type PlanProgress } from '../plan-progress'

const FOLLOW_MS = 5_000

export function usePlanProgress(proposal: PlanProposal): { progress: PlanProgress | undefined; error: unknown } {
  const settled = useRef(false)
  const follow = { refetchInterval: () => (settled.current ? false as const : FOLLOW_MS), refetchIntervalInBackground: true }
  const wanted = proposal.status === 'adopted' && followedStories(proposal).length > 0

  const leaves = useQuery({ queryKey: groveKeys.leaves(), queryFn: listLeaves, enabled: wanted, ...follow })
  const needsBranches = wanted && !proposal.adopted?.treeId && !proposal.change?.treeId
  const branches = useQuery({ queryKey: groveKeys.branches(), queryFn: listBranches, enabled: needsBranches })
  const treeId = wanted ? plansTree(proposal, leaves.data ?? [], branches.data ?? []) : undefined
  const run = useQuery({ queryKey: groveKeys.run(treeId ?? ''), queryFn: () => getTreeRun(treeId!), enabled: Boolean(treeId), ...follow })
  const plans = useQuery({ queryKey: planKeys.forTree(treeId ?? ''), queryFn: () => listTreePlans(treeId!), enabled: Boolean(treeId), ...follow })

  const progress = useMemo(
    () => (wanted && leaves.data ? planProgress(proposal, { treeId, leaves: leaves.data, run: run.data, plans: plans.data ?? [] }) : undefined),
    [wanted, proposal, treeId, leaves.data, run.data, plans.data],
  )
  useEffect(() => { settled.current = progress?.done === true }, [progress])

  return { progress, error: leaves.error ?? run.error ?? plans.error }
}
