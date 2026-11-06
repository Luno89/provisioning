import { describe, expect, it } from 'vitest'
import { deleteProjectFile, dropIntoRepository, getProjectFileContent, listProjectFiles, saveProjectFileContent } from './project-files'
import { startBackend } from '../../../test/backend/site'
import { outsideThisTier } from '../../../test/backend/outside'
import { authorize, type Principal } from '../../../../../backend/src/platform/lib/permissions'
import { projectFilesRouter } from '../../../../../backend/src/files/routes/project-files'
import { RepositoryDropService } from '../../../../../backend/src/files/services/RepositoryDropService'
import type { GiteaService } from '../../../../../backend/src/projects/services/GiteaService'
import type { ProjectRepoService } from '../../../../../backend/src/projects/services/ProjectRepoService'
import type { StoryDropService } from '../../../../../backend/src/files/services/StoryDropService'

const backend = await startBackend(({ api, db }) => {
  const gitea = outsideThisTier<GiteaService>('Gitea')
  const repos = outsideThisTier<ProjectRepoService>('Gitea')
  api.use('/projects', projectFilesRouter({
    projectRepoService: repos,
    giteaService: gitea,
    getOwnedProject: async (id: string, principal: Principal) => {
      const project = (await db.projects.getProjects()).find((p) => p.id === id)
      return project && authorize(principal, 'see', { kind: 'project', ownerId: project.ownerId }).allowed ? project : undefined
    },
    drops: new RepositoryDropService({
      credential: (ownerId) => repos.editorCredential(ownerId),
      commit: (credential, owner, repo, files, message, branch) => gitea.commitDropFromDisk(credential, owner, repo, files, message, branch),
      writeOnDevice: () => { throw new Error('writing on a person\'s machine needs the machine, which the integration tier never reaches') },
    }),
    storyDrops: outsideThisTier<StoryDropService>('story drops'),
  }))
})

const owner = await backend.signIn()
await backend.db.projects.saveProject({ id: 'no-repo', name: 'No repository', ownerId: owner.id, appType: 'gitapp', createdAt: new Date().toISOString() })
const code = (text: string) => ({ path: 'src/a.ts', file: new Blob([text]) })

describe('a project\'s repository files, as the Files page asks for them', () => {
  it('says the project has no repository when it has none', async () => {
    await expect(listProjectFiles('no-repo')).rejects.toMatchObject({ response: { status: 409, data: { error: 'this project has no repository' } } })
    await expect(getProjectFileContent('no-repo', 'README.md')).rejects.toMatchObject({ response: { status: 409, data: { error: 'this project has no repository' } } })
  })

  it('refuses a path that climbs out of the repository before reading anything', async () => {
    await expect(listProjectFiles('no-repo', '../etc')).rejects.toMatchObject({ response: { status: 400, data: { error: 'path must stay inside the repository.' } } })
    await expect(getProjectFileContent('no-repo', '../etc/passwd')).rejects.toMatchObject({ response: { status: 400, data: { error: 'path must name a file inside the repository.' } } })
    await expect(saveProjectFileContent('no-repo', { path: '../x', content: 'x', sha: 'a' })).rejects.toMatchObject({ response: { status: 400 } })
    await expect(deleteProjectFile('no-repo', '../x', 'a')).rejects.toMatchObject({ response: { status: 400 } })
  })

  it('reads a drop the way the browser streams it and refuses it for a project with no repository', async () => {
    await expect(dropIntoRepository('no-repo', { dir: '' }, [code('export const a = 1')])).rejects.toMatchObject({ response: { status: 409, data: { error: 'This project has no repository to drop files into.' } } })
  })

  it('answers 404 for a project that is someone else\'s', async () => {
    await backend.signInAnother('second@koala.test')
    await expect(listProjectFiles('no-repo')).rejects.toMatchObject({ response: { status: 404, data: { error: 'Project not found' } } })
    await expect(getProjectFileContent('no-repo', 'README.md')).rejects.toMatchObject({ response: { status: 404 } })
    await expect(saveProjectFileContent('no-repo', { path: 'README.md', content: 'x', sha: 'a' })).rejects.toMatchObject({ response: { status: 404 } })
    await expect(deleteProjectFile('no-repo', 'README.md', 'a')).rejects.toMatchObject({ response: { status: 404 } })
    await expect(dropIntoRepository('no-repo', { dir: '' }, [code('x')])).rejects.toMatchObject({ response: { status: 404 } })
  })
})
