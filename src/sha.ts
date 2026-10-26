/** The id git gives a file's contents: sha1("blob <size>\0" + bytes). */
export async function gitBlobSha(data: Uint8Array): Promise<string> {
	const header = new TextEncoder().encode(`blob ${data.length}\0`);
	const buf = new Uint8Array(header.length + data.length);
	buf.set(header, 0);
	buf.set(data, header.length);
	const digest = await crypto.subtle.digest("SHA-1", buf);
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
