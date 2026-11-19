import { serviceStep, type Provider, type ServiceContext, type Step } from '@koala/provision';
import { httpAnswers, minioHealthUrl, type MinioPlace } from '../../platform/index.js';

export const MINIO_TITLE = 'MinIO, the file store,';

export function minioStep<Context extends ServiceContext>(provider: Provider<Context>, at: () => MinioPlace): Step<Context> {
  return serviceStep({ id: 'minio', title: MINIO_TITLE, provider, answers: () => httpAnswers(minioHealthUrl(at()))() });
}
