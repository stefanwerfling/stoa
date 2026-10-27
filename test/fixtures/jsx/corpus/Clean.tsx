// A component with no statically-detectable accessibility defects.
export function Clean({open}: {open: boolean}) {
    return (
        <main>
            <img src="/ok.png" alt="A described image" />
            <img src="/deco.png" alt="" />
            <button type="button" aria-label="Close" aria-expanded={open}>x</button>
            <div role="navigation" aria-hidden="true">off-tree</div>
            <a href="/go" tabIndex={0}>Go</a>
            <iframe src="/map" title="Location map" />
        </main>
    );
}
