# Audit: tests/gpu-live.ts (2026-11-11)

## What failed
Its first two runs against this computer's two RTX 3090s, both at the same stage: vLLM deployed through Koala failed after Koala
had readied the GPUs (the node went from 0 to 2 advertised NVIDIA GPUs), and the app's record said only `failed`.

1. `DownloadModelActivity`: `EACCES: permission denied, mkdir '/var/lib/rancher'`.
2. After the fix for that: `DownloadModelActivity`: `Cannot read properties of undefined (reading 'access')`.

Neither was flaky. Each was a fault in the code the suite was the first to run end to end.

## The causes
1. The model download ran inside the cluster worker, which since the move to one kind of cluster runs as a pod on the machine Koala
   runs in. It wrote the model into the machine's cache folder (`/var/lib/rancher/<folder>`) as if it ran on the host, and the pod
   has no such folder. The vLLM construct had the same mistake one layer down: at synth time it decided whether the model was
   pre-downloaded by looking for the folder in the worker's filesystem. No test ran the download where it runs in production: its
   unit and integration tests ran it in the test's own process against a stand-in Hugging Face.
2. The new download activity takes the worker's `ClusterAccess` as a second parameter, and the cluster worker registered it bare
   (`DownloadModelActivity,`), so Temporal called it with its arguments alone. TypeScript accepts a two-parameter function where a
   one-parameter one is expected, and no test exercised the worker's registration.

The failed app showing no reason came from the bridge: `settle` received only how the workflow closed, never why.

## How it is now built
- The model is downloaded on the machine that runs it, as a Kubernetes Job through `ClusterAccess` (owner's decision, "Lets do A"):
  in the app's own image (`modelImageOf`, the one rule naming vLLM's and TabbyAPI's images, also handed to the constructs), writing
  into that machine's cache folder, which the constructs mount; the deploy and a settings change ready the model through one workflow
  helper (`readyModel`) and tell the stack it is there. Its integration test runs the job on the real k3s against a stand-in Hugging
  Face inside the cluster: downloaded, found again, and each refusal's words.
- The cluster worker's activities are one exported map (`clusterActivities`), and `worker-cluster.test.ts` holds every one to taking
  its one arguments object, and runs the download as Temporal calls it. Putting the bare registration back fails both.
- A failed deploy, resize, settings change or removal keeps why on the app's record (`failure`, the innermost cause, read by
  `closedWith` in the same read that says how the workflow closed), shown on its row, cleared by a later success.

The third run passed: both GPUs reported, three refused with the fix, readied, the model downloaded by the job, vLLM serving
Qwen2.5-0.5B on one GPU answered.
