import { describe, expect, it } from 'vitest';
import { NO_KUBECTL, container, envVar, find, podSpec, render } from './render.js';

describe.skipIf(NO_KUBECTL)('deploy/k8s overlays/kind and kind-ci', () => {
  it('kind uses the locally loaded images', () => {
    const objs = render('overlays/kind');
    expect(container(find(objs, 'Deployment', 'moca-supervisor', 'moca'), 'supervisor').image).toBe(
      'dev.local/moca:local',
    );
    expect(
      container(find(objs, 'StatefulSet', 'moca-sandbox', 'moca-sandbox'), 'sandbox').image,
    ).toBe('dev.local/moca-remote-worker:local');
  });

  it('kind-ci adds a loopback mock model beside the supervisor, from a ConfigMap setup.sh creates', () => {
    const objs = render('overlays/kind-ci');
    const dep = find(objs, 'Deployment', 'moca-supervisor', 'moca');
    // A native sidecar, so the kubelet stops it only after the supervisor has drained and exited.
    expect(podSpec(dep).containers.map((c: { name: string }) => c.name)).toEqual(['supervisor']);
    const mock = (podSpec(dep).initContainers ?? []).find(
      (c: { name: string }) => c.name === 'mock-model',
    );
    expect(mock.restartPolicy).toBe('Always');
    expect(mock.securityContext).toMatchObject({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
    });
    expect(mock.command).toEqual(['node', '/mock/mock-anthropic.mjs', '--port', '18099']);
    // kind's image transformer ran before this patch existed; kind-ci must rewrite it itself.
    expect(mock.image).toBe('dev.local/moca:local');
    const vol = podSpec(dep).volumes.find((v: { name: string }) => v.name === 'mock-model');
    expect(vol.configMap.name).toBe('moca-mock-model');
    // Created by setup.sh from deploy/microvm/mock-anthropic.mjs, never by kustomize: no
    // kustomization reads a file outside its root.
    expect(objs.filter((o) => o.kind === 'ConfigMap')).toEqual([]);
  });

  it('kind-ci points the supervisor at the mock and keeps every base variable', () => {
    const objs = render('overlays/kind-ci');
    const sup = container(find(objs, 'Deployment', 'moca-supervisor', 'moca'), 'supervisor');
    expect(envVar(sup, 'SH_MODEL_BASE_URL')?.value).toBe('http://127.0.0.1:18099');
    expect(envVar(sup, 'SH_MODEL_CUSTOM')?.value).toBe('1');
    // Strategic merge must ADD to env, not replace it.
    expect(envVar(sup, 'SH_RELAY_ADDR')?.value).toBe('sandbox-relay-exec.moca.svc:9444');
    expect(envVar(sup, 'SH_REQUIRE_AUTH')?.value).toBe('true');
  });

  it('kind-ci still has exactly one supervisor container (the mock is not a worker)', () => {
    const dep = find(render('overlays/kind-ci'), 'Deployment', 'moca-supervisor', 'moca');
    expect(
      podSpec(dep).containers.filter(
        (c: { workingDir?: string }) => c.workingDir === '/app/packages/supervisor',
      ),
    ).toHaveLength(1);
  });
});
