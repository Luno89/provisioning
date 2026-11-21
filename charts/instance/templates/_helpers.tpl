{{- define "instance.name" -}}{{ .Release.Name }}{{- end -}}

{{- define "instance.labels" -}}
app.kubernetes.io/part-of: nowrinkles-instance
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "instance.selector" -}}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "instance.secret" -}}
{{- $existing := lookup "v1" "Secret" .root.Release.Namespace (printf "%s-keys" .root.Release.Name) -}}
{{- if and $existing (index $existing.data .key) -}}
{{ index $existing.data .key }}
{{- else -}}
{{ randAlphaNum .length | b64enc }}
{{- end -}}
{{- end -}}

{{- define "instance.clientKey" -}}
{{- $existing := lookup "v1" "Secret" .Release.Namespace (printf "%s-keys" .Release.Name) -}}
{{- if and $existing (index $existing.data "INSTANCE_CLIENT_KEY") -}}
{{ index $existing.data "INSTANCE_CLIENT_KEY" }}
{{- else -}}
{{ genPrivateKey "ed25519" | b64enc }}
{{- end -}}
{{- end -}}

{{- define "instance.image" -}}{{ .Values.image.repository }}:{{ .Values.image.tag }}{{ with .Values.image.digest }}@{{ . }}{{ end }}{{- end -}}

{{- define "instance.resources" -}}
{{- with index .root.Values.resources .component }}
resources: {{- toYaml . | nindent 2 }}
{{- end -}}
{{- end -}}


{{- define "instance.temporalKeys" -}}
name: temporal-keys
image: {{ .Values.temporal.keysImage }}
command: [httpd, -f, -p, "7280", -h, /srv]
{{- include "instance.resources" (dict "root" . "component" "temporalKeys") }}
volumeMounts:
  - name: temporal-keys
    mountPath: /srv/.well-known
    readOnly: true
{{- end -}}
