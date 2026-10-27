import type {Node} from 'web-tree-sitter';
import type {Fact} from '../Types.js';
import {parseHtmlTree} from './HtmlAdapter.js';
import type {FileRef, LanguageAdapter, ParseResult, ProjectContext} from './LanguageAdapter.js';
import {extractTemplateA11yFacts, type BindingDialect} from './template/TemplateExtraction.js';

// Vue binding syntax → plain attribute + dynamic flag. v-bind (`:x` / `v-bind:x`)
// is a dynamic attribute; v-on (`@x` / `v-on:x`), slots (`#x`) and the other
// `v-` directives are not a11y attributes and are dropped. Modifiers (`.prop`)
// on a bound name are stripped.
const VUE_DIALECT: BindingDialect = {
    normalize(rawName: string): {name: string; dynamic: boolean} | null {
        if (rawName.startsWith('@') || rawName.startsWith('v-on:') || rawName.startsWith('#')) {
            return null;
        }
        if (rawName.startsWith('v-bind:')) {
            return {name: boundName(rawName.slice('v-bind:'.length)), dynamic: true};
        }
        if (rawName.startsWith(':')) {
            return {name: boundName(rawName.slice(1)), dynamic: true};
        }
        if (rawName.startsWith('v-')) {
            return null;
        }
        return {name: rawName, dynamic: false};
    }
};

const boundName = (name: string): string => name.split('.')[0] ?? name;

/**
 * Vue single-file-component adapter. The `.vue` template section is HTML-family
 * markup (tree-sitter-html, reusing the shared parser), so the same static,
 * low-false-positive accessibility facts the HTML adapter produces are emitted
 * here — after normalising Vue bindings so a bound value (`:alt`, `{{…}}`) counts
 * as present-but-unknown rather than missing. Only the elements inside
 * `<template>` are analysed; `<script>`/`<style>` are ignored.
 */
export class VueAdapter implements LanguageAdapter {
    public readonly id = 'vue';
    public readonly version = '0.1.0';

    public supports(file: FileRef): boolean {
        return file.path.endsWith('.vue');
    }

    public parse(file: FileRef): ParseResult {
        const root = parseHtmlTree(file.content);
        if (root === null) {
            return {file, ok: false, diagnostics: ['html parser not initialized; call initHtml() before analyze()']};
        }
        return {file, ok: true, diagnostics: [], handle: root};
    }

    public extractFacts(parsed: ParseResult, _ctx: ProjectContext): Fact[] {
        if (parsed.handle === undefined) {
            return [];
        }
        return extractTemplateA11yFacts(parsed.handle as Node, parsed.file.content, parsed.file.path, {id: this.id, version: this.version}, VUE_DIALECT);
    }
}
