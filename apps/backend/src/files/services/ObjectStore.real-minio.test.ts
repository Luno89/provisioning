import { inject } from 'vitest';
import { testBucket } from '../testing/real-minio.js';
import { objectStoreContract } from '../testing/object-store-contract.js';
import { minioObjectStore } from './ObjectStore.js';

objectStoreContract(async () => minioObjectStore({ ...inject('minio'), bucket: testBucket() }));
