package session_test

import (
	"reflect"
	"testing"

	"github.com/rossoctl/moca/remote-worker/internal/session"
)

func lookupFrom(m map[string]string) func(string) (string, bool) {
	return func(k string) (string, bool) { v, ok := m[k]; return v, ok }
}

func TestTierLabels(t *testing.T) {
	cases := []struct {
		name string
		env  map[string]string
		def  string
		want map[string]string
	}{
		{"unset uses the default", map[string]string{}, "microvm", map[string]string{"moca.dev/tier": "microvm"}},
		{"set wins", map[string]string{"SANDBOX_TIER": "gpu"}, "container", map[string]string{"moca.dev/tier": "gpu"}},
		{"trimmed", map[string]string{"SANDBOX_TIER": "  gpu "}, "container", map[string]string{"moca.dev/tier": "gpu"}},
		// Set but empty is an operator choosing NO tier; it must not fall back to the default.
		{"set but empty sends no label", map[string]string{"SANDBOX_TIER": ""}, "container", nil},
		{"whitespace only sends no label", map[string]string{"SANDBOX_TIER": "  "}, "container", nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := session.TierLabels(lookupFrom(c.env), c.def)
			if !reflect.DeepEqual(got, c.want) {
				t.Errorf("TierLabels = %v, want %v", got, c.want)
			}
		})
	}
	if session.TierLabelKey != "moca.dev/tier" {
		t.Errorf("TierLabelKey = %q", session.TierLabelKey)
	}
}

func TestTemplateLabels(t *testing.T) {
	cases := []struct {
		name string
		env  map[string]string
		want map[string]string
	}{
		{"unset sends no label", map[string]string{}, nil},
		{"set", map[string]string{"SANDBOX_TEMPLATE": "django-django-11133"}, map[string]string{"moca.dev/template": "django-django-11133"}},
		{"trimmed", map[string]string{"SANDBOX_TEMPLATE": " py312 "}, map[string]string{"moca.dev/template": "py312"}},
		{"blank sends no label", map[string]string{"SANDBOX_TEMPLATE": "  "}, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := session.TemplateLabels(lookupFrom(c.env)); !reflect.DeepEqual(got, c.want) {
				t.Errorf("TemplateLabels = %v, want %v", got, c.want)
			}
		})
	}
	if session.TemplateLabelKey != "moca.dev/template" {
		t.Errorf("TemplateLabelKey = %q", session.TemplateLabelKey)
	}
}

func TestLabelsMergesTierAndTemplate(t *testing.T) {
	cases := []struct {
		name string
		env  map[string]string
		want map[string]string
	}{
		{"neither: the default tier only", map[string]string{}, map[string]string{"moca.dev/tier": "microvm"}},
		{"both", map[string]string{"SANDBOX_TIER": "microvm", "SANDBOX_TEMPLATE": "py312"},
			map[string]string{"moca.dev/tier": "microvm", "moca.dev/template": "py312"}},
		{"a template with no tier", map[string]string{"SANDBOX_TIER": "", "SANDBOX_TEMPLATE": "py312"},
			map[string]string{"moca.dev/template": "py312"}},
		{"no tier, no template: nil", map[string]string{"SANDBOX_TIER": ""}, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := session.Labels(lookupFrom(c.env), "microvm"); !reflect.DeepEqual(got, c.want) {
				t.Errorf("Labels = %v, want %v", got, c.want)
			}
		})
	}
}
