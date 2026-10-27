export function Names({label, id}: {label: string; id: string}) {
    return (
        <div>
            {/* buttons */}
            <button></button>
            <button>Save</button>
            <button>{label}</button>
            <button aria-label="Close" />
            <button><span>Delete</span></button>
            <button><Icon /></button>
            <button><img src="/i.png" alt="Print" /></button>
            <button><img src="/i.png" alt="" /></button>

            {/* links */}
            <a href="/a"></a>
            <a href="/b">Home</a>
            <a href="/c" aria-label="Profile"><svg /></a>
            <a>bare anchor, not a link</a>

            {/* fields */}
            <input type="text" />
            <input type="text" aria-label="Search" />
            <input type="text" id="e" />
            <label htmlFor="e">Email</label>
            <label>Name <input type="text" /></label>
            <input type="submit" value="Send" />
            <input type="text" id={id} />
            <select></select>
        </div>
    );
}

function Icon() {
    return <svg />;
}
