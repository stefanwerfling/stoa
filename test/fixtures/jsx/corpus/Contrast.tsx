export function Palette({dynamicBg}: {dynamicBg: string}) {
    return (
        <div>
            <p style={{color: '#999999', backgroundColor: '#ffffff'}}>grey on white, fails</p>
            <p style={{color: '#595959', backgroundColor: '#ffffff'}}>dark grey on white, passes</p>
            <p style={{color: '#aaaaaa', backgroundColor: '#ffffff', fontSize: 24}}>large text below 3:1, fails</p>
            <p style={{color: '#777777', backgroundColor: '#ffffff', fontSize: 24}}>large text ok at 3:1, passes</p>
            <p style={{color: '#000000', backgroundColor: '#ffffff'}}>black on white, passes</p>
            <p style={{color: '#999999', backgroundColor: dynamicBg}}>dynamic bg, skipped</p>
            <p style={{color: '#333333'}}>no background, skipped</p>
            <p style={{color: 'rgba(0,0,0,0.4)', backgroundColor: '#fff'}}>translucent fg, skipped</p>
            <p>no style at all</p>
        </div>
    );
}
