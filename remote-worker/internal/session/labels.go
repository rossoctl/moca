package session

import "strings"

// TierLabelKey is the presence label the harness filters sandboxes on (P6.3 spec §3.1). The relay
// copies Hello.labels into the presence record unchanged, so this one key is the whole contract
// between a worker and selectPoolSandbox's tier filter.
const TierLabelKey = "moca.dev/tier"

// TierLabels returns the Hello labels for this worker's sandbox tier: SANDBOX_TIER when it is set,
// def when it is unset. Set but empty (or blank) means no label at all, deliberately unlike env()'s
// empty-means-default: an operator attaching a worker with no tier on purpose must not be overridden
// by the binary's default, and a tiered harness excludes an unlabelled worker loudly (spec §4 step 1).
func TierLabels(lookup func(string) (string, bool), def string) map[string]string {
	v, ok := lookup("SANDBOX_TIER")
	if !ok {
		v = def
	}
	v = strings.TrimSpace(v)
	if v == "" {
		return nil
	}
	return map[string]string{TierLabelKey: v}
}

// TemplateLabelKey is the presence label naming the sandbox template this worker serves (the
// session-templates spec §3.1): the harness keeps a session that asked for template T on workers
// labelled T, and a session that asked for none on workers without the label.
const TemplateLabelKey = "moca.dev/template"

// TemplateLabels returns the Hello label for SANDBOX_TEMPLATE: set and non-blank, the trimmed
// value; unset or blank, none. There is no default: a worker serves a template only when its
// operator says so, because an untemplated session must never land on it.
func TemplateLabels(lookup func(string) (string, bool)) map[string]string {
	v, _ := lookup("SANDBOX_TEMPLATE")
	v = strings.TrimSpace(v)
	if v == "" {
		return nil
	}
	return map[string]string{TemplateLabelKey: v}
}

// Labels is a worker's whole Hello label set: its tier (TierLabels, with def) and its template
// (TemplateLabels). Nil when it has neither.
func Labels(lookup func(string) (string, bool), def string) map[string]string {
	out := TierLabels(lookup, def)
	for k, v := range TemplateLabels(lookup) {
		if out == nil {
			out = map[string]string{}
		}
		out[k] = v
	}
	return out
}
