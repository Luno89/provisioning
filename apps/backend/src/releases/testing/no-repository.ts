export const noRepositoryRead = async (): Promise<string[]> => {
  throw new Error('this test keeps no repository, so no project in it has a tree type that names what its app is built from');
};
