import type {Node} from 'web-tree-sitter';
import type {Fact} from '../Types.js';
import {parseHtmlTree} from './HtmlAdapter.js';
import type {FileRef, LanguageAdapter, ParseResult, ProjectContext} from './LanguageAdapter.js';
import {extractTemplateA11yFacts, type BindingDialect} from './template/TemplateExtraction.js';

// Angular template binding syntax → plain attribute + dynamic flag.
//   [attr.aria-label]="x" / [alt]="x" / bind-alt="x"  → dynamic attribute
//   (click)="…" / [(ngModel)]="…" / *ngIf / #ref / on-…  → not a11y attributes, dropped
// Property bindings to sub-targets ([style.color], [class.x]) collapse to the
// base attribute (style/class), marked dynamic.
const ANGULAR_DIALECT: BindingDialect = {
    normalize(rawName: string): {name: string; dynamic: boolean} | null {
        if (rawName.startsWith('(') || rawName.startsWith('[(') || rawName.startsWith('*') || rawName.startsWith('#') || rawName.startsWith('on-') || rawName.startsWith('bindon-')) {
            return null;
        }
        if (rawName.startsWith('[') && rawName.endsWith(']')) {
            const inner = rawName.slice(1, -1);
            const bare = inner.startsWith('attr.') ? inner.slice('attr.'.length) : inner;
            return {name: baseName(bare), dynamic: true};
        }
        if (rawName.startsWith('bind-')) {
            return {name: baseName(rawName.slice('bind-'.length)), dynamic: true};
        }
        return {name: rawName, dynamic: false};
    }
};

const baseName = (name: string): string => name.split('.')[0] ?? name;

/**
 * Angular template adapter. An external `*.component.html` template is
 * HTML-family markup (tree-sitter-html, shared parser), so the same static,
 * low-false-positive accessibility facts are emitted — after normalising Angular
 * bindings so `[alt]`/`[attr.aria-label]` count as present-but-unknown rather than
 * missing, and events/structural directives are dropped. It must be registered
 * before the HTML adapter so `.component.html` is handled here, not as plain HTML.
 * Inline `template:` strings in `.ts` are not covered (a separate step).
 */
export class AngularAdapter implements LanguageAdapter {
    public readonly id = 'angular';
    public readonly version = '0.1.0';

    public supports(file: FileRef): boolean {
        return file.path.endsWith('.component.html');
    }

    public parse(file: FileRef): ParseResult {
        const parsed = parseHtmlTree(file.content);
        if (parsed === null) {
            return {file, ok: false, diagnostics: ['html parser not initialized; call initHtml() before analyze()']};
        }
        return {file, ok: true, diagnostics: [], handle: parsed.root, release: parsed.release};
    }

    public extractFacts(parsed: ParseResult, _ctx: ProjectContext): Fact[] {
        if (parsed.handle === undefined) {
            return [];
        }
        return extractTemplateA11yFacts(parsed.handle as Node, parsed.file.content, parsed.file.path, {id: this.id, version: this.version}, ANGULAR_DIALECT);
    }
}
