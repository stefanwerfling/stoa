async function save(): Promise<void> {}

export async function run(): Promise<void> {
    save(); // floating — rejection unhandled
    void save(); // deliberate fire-and-forget — OK
    save().catch(() => {}); // handled — OK
    await save(); // awaited — OK
}
