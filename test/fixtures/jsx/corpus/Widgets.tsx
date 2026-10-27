// Uses the automatic JSX runtime (no `import React` needed), so the fixture
// stays focused on accessibility facts rather than import hygiene.
export function Widgets({desc, props}: {desc: string; props: Record<string, unknown>}) {
    return (
        <div>
            <img src="/a.png" />
            <img src="/b.png" alt="A described image" />
            <img src="/c.png" alt={desc} />
            <img src="/d.png" {...props} />
            <div role="buton">typo role</div>
            <div role="navigation">valid role</div>
            <span aria-labeledby="x">unknown aria attr</span>
            <span aria-hidden="yes">invalid aria value</span>
            <button tabIndex={5}>Jump</button>
            <button aria-hidden="true" tabIndex={0}>Hidden but focusable</button>
            <iframe src="/map" />
            <iframe src="/video" title="Intro" />
            <Button />
        </div>
    );
}

function Button() {
    return <button>x</button>;
}
