import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SETUP_LABEL } from '@koala/provision';

export function tinyChart(): string {
  const chart = mkdtempSync(join(tmpdir(), 'koala-tiny-chart-'));
  mkdirSync(join(chart, 'templates'));
  writeFileSync(join(chart, 'Chart.yaml'), 'apiVersion: v2\nname: tiny\nversion: 0.1.0\n');
  writeFileSync(join(chart, 'values.yaml'), 'image: busybox:1.37\nsetup: "echo set up"\n');
  writeFileSync(join(chart, 'templates', 'app.yaml'), [
    'apiVersion: apps/v1',
    'kind: Deployment',
    'metadata:',
    '  name: {{ .Release.Name }}-app',
    '  labels: { app.kubernetes.io/instance: {{ .Release.Name }} }',
    'spec:',
    '  replicas: 1',
    '  selector: { matchLabels: { app.kubernetes.io/instance: {{ .Release.Name }} } }',
    '  template:',
    '    metadata: { labels: { app.kubernetes.io/instance: {{ .Release.Name }} } }',
    '    spec:',
    '      terminationGracePeriodSeconds: 0',
    '      containers: [{ name: app, image: {{ .Values.image | quote }}, command: [sleep, "100000"] }]',
    '',
  ].join('\n'));
  writeFileSync(join(chart, 'templates', 'setup.yaml'), [
    'apiVersion: batch/v1',
    'kind: Job',
    'metadata:',
    '  name: {{ .Release.Name }}-setup-{{ .Release.Revision }}',
    `  labels: { app.kubernetes.io/instance: {{ .Release.Name }}, ${SETUP_LABEL}: setup }`,
    'spec:',
    '  backoffLimit: 0',
    '  template:',
    '    metadata: { labels: { app.kubernetes.io/instance: {{ .Release.Name }} } }',
    '    spec:',
    '      restartPolicy: Never',
    '      terminationGracePeriodSeconds: 0',
    '      containers: [{ name: setup, image: busybox:1.37, command: [sh, -c, {{ .Values.setup | quote }}] }]',
    '',
  ].join('\n'));
  return chart;
}
