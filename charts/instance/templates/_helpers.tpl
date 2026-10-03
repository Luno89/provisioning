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

{{- define "instance.image" -}}{{ .Values.image.repository }}:{{ .Values.image.tag }}{{- end -}}
