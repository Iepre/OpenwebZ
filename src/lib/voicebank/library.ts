import JSZip from 'jszip';
import { encodeText } from '#lib/io/text';
import type { SampleFile, Voicebank } from './types';

const DB_NAME = 'openwebz-voicebanks';
const DB_VERSION = 1;
const STORE_BANKS = 'banks';
const STORE_SAMPLES = 'samples';
const ACTIVE_KEY = 'openwebz:active-voicebank';

export interface SavedSampleMeta {
	path: string;
	key: string;
	size: number;
}

export interface SavedVoicebankMeta {
	id: string;
	name: string;
	author: string;
	aliasCount: number;
	sampleCount: number;
	totalBytes: number;
	generatedOto: boolean;
	addedAt: number;
	lastUsedAt: number;
	sourceUrl?: string;
}

interface StoredBankRow extends SavedVoicebankMeta {
	oto: Uint8Array<ArrayBuffer>;
	prefixMap: Uint8Array<ArrayBuffer> | null;
	characterEntries: [string, string][];
	aliases: string[];
	aliasFile: [string, string][];
	imageBytes: Uint8Array<ArrayBuffer> | null;
	imageType: string | null;
	samples: SavedSampleMeta[];
}

interface StoredSampleRow {
	cacheKey: string;
	bankId: string;
	key: string;
	path: string;
	size: number;
	data: Uint8Array<ArrayBuffer>;
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

function txDone(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error);
	});
}

function toMeta(row: StoredBankRow): SavedVoicebankMeta {
	return {
		id: row.id,
		name: row.name,
		author: row.author,
		aliasCount: row.aliasCount,
		sampleCount: row.sampleCount,
		totalBytes: row.totalBytes,
		generatedOto: row.generatedOto,
		addedAt: row.addedAt,
		lastUsedAt: row.lastUsedAt,
		sourceUrl: row.sourceUrl
	};
}

export function getRememberedActiveId(): string | null {
	try {
		return typeof localStorage !== 'undefined' ? localStorage.getItem(ACTIVE_KEY) : null;
	} catch {
		return null;
	}
}

export function setRememberedActiveId(id: string | null) {
	try {
		if (typeof localStorage === 'undefined') return;
		if (id) localStorage.setItem(ACTIVE_KEY, id);
		else localStorage.removeItem(ACTIVE_KEY);
	} catch {
		/* storage unavailable */
	}
}

class VoicebankLibrary {
	private dbPromise: Promise<IDBDatabase | null> | null = null;

	private openDb(): Promise<IDBDatabase | null> {
		if (typeof indexedDB === 'undefined') return Promise.resolve(null);
		this.dbPromise ??= new Promise((resolve) => {
			try {
				const req = indexedDB.open(DB_NAME, DB_VERSION);
				req.onupgradeneeded = () => {
					const db = req.result;
					if (!db.objectStoreNames.contains(STORE_BANKS)) {
						db.createObjectStore(STORE_BANKS, { keyPath: 'id' });
					}
					if (!db.objectStoreNames.contains(STORE_SAMPLES)) {
						const samples = db.createObjectStore(STORE_SAMPLES, { keyPath: 'cacheKey' });
						samples.createIndex('bankId', 'bankId');
					}
				};
				req.onsuccess = () => resolve(req.result);
				req.onerror = () => resolve(null);
			} catch {
				resolve(null);
			}
		});
		return this.dbPromise;
	}

	async list(): Promise<SavedVoicebankMeta[]> {
		const db = await this.openDb();
		if (!db) return [];
		try {
			const rows = await promisify<StoredBankRow[]>(
				db.transaction(STORE_BANKS).objectStore(STORE_BANKS).getAll()
			);
			return rows.map(toMeta).sort((a, b) => b.lastUsedAt - a.lastUsedAt);
		} catch {
			return [];
		}
	}

	async save(vb: Voicebank, sourceUrl?: string): Promise<SavedVoicebankMeta | null> {
		const db = await this.openDb();
		if (!db) return null;

		let imageBytes: Uint8Array<ArrayBuffer> | null = null;
		let imageType: string | null = null;
		if (vb.image) {
			try {
				const res = await fetch(vb.image);
				const blob = await res.blob();
				imageType = blob.type || 'image/png';
				imageBytes = new Uint8Array(await blob.arrayBuffer());
			} catch {
				imageBytes = null;
			}
		}

		// Read all sample payloads first outside IDB transaction (transactions auto-commit across awaits).
		const sampleEntries: StoredSampleRow[] = [];
		const sampleManifest: SavedSampleMeta[] = [];
		let totalBytes =
			vb.oto.byteLength + (vb.prefixMap?.byteLength ?? 0) + (imageBytes?.byteLength ?? 0);

		for (const s of vb.samples.values()) {
			const data = await s.read();
			totalBytes += data.byteLength;
			sampleEntries.push({
				cacheKey: `${vb.id}|${s.key}`,
				bankId: vb.id,
				key: s.key,
				path: s.path,
				size: s.size || data.byteLength,
				data
			});
			sampleManifest.push({
				path: s.path,
				key: s.key,
				size: s.size || data.byteLength
			});
		}

		const now = Date.now();
		const existing = await promisify<StoredBankRow | undefined>(
			db.transaction(STORE_BANKS).objectStore(STORE_BANKS).get(vb.id)
		).catch(() => undefined);

		const row: StoredBankRow = {
			id: vb.id,
			name: vb.name,
			author: vb.character.get('author') ?? '',
			aliasCount: vb.aliases.length,
			sampleCount: sampleManifest.length,
			totalBytes,
			generatedOto: vb.generatedOto,
			addedAt: existing?.addedAt ?? now,
			lastUsedAt: now,
			sourceUrl: sourceUrl ?? existing?.sourceUrl,
			oto: new Uint8Array(vb.oto),
			prefixMap: vb.prefixMap ? new Uint8Array(vb.prefixMap) : null,
			characterEntries: [...vb.character.entries()],
			aliases: [...vb.aliases],
			aliasFile: [...vb.aliasFile.entries()],
			imageBytes,
			imageType,
			samples: sampleManifest
		};

		const tx = db.transaction([STORE_BANKS, STORE_SAMPLES], 'readwrite');
		tx.objectStore(STORE_BANKS).put(row);
		const sampleStore = tx.objectStore(STORE_SAMPLES);
		for (const item of sampleEntries) sampleStore.put(item);
		await txDone(tx);

		return toMeta(row);
	}

	async load(id: string): Promise<Voicebank | null> {
		const db = await this.openDb();
		if (!db) return null;

		const row = await promisify<StoredBankRow | undefined>(
			db.transaction(STORE_BANKS).objectStore(STORE_BANKS).get(id)
		).catch(() => undefined);
		if (!row) return null;

		// Update lastUsedAt asynchronously.
		void (async () => {
			try {
				const tx = db.transaction(STORE_BANKS, 'readwrite');
				tx.objectStore(STORE_BANKS).put({ ...row, lastUsedAt: Date.now() } satisfies StoredBankRow);
				await txDone(tx);
			} catch {
				/* ignore */
			}
		})();

		const image =
			row.imageBytes && row.imageType
				? URL.createObjectURL(new Blob([row.imageBytes], { type: row.imageType }))
				: null;

		const samples = new Map<string, SampleFile>();
		for (const meta of row.samples) {
			const cacheKey = `${row.id}|${meta.key}`;
			samples.set(meta.key, {
				path: meta.path,
				key: meta.key,
				size: meta.size,
				read: async () => {
					const sRow = await promisify<StoredSampleRow | undefined>(
						db.transaction(STORE_SAMPLES).objectStore(STORE_SAMPLES).get(cacheKey)
					);
					if (!sRow) throw new Error(`Sample "${meta.path}" is missing from library storage.`);
					return new Uint8Array(sRow.data);
				}
			});
		}

		return {
			kind: 'utau',
			id: row.id,
			name: row.name,
			image,
			character: new Map(row.characterEntries),
			oto: new Uint8Array(row.oto),
			generatedOto: row.generatedOto,
			prefixMap: row.prefixMap ? new Uint8Array(row.prefixMap) : null,
			samples,
			aliases: [...row.aliases],
			aliasFile: new Map(row.aliasFile)
		};
	}

	async remove(id: string): Promise<void> {
		const db = await this.openDb();
		if (!db) return;

		const tx = db.transaction([STORE_BANKS, STORE_SAMPLES], 'readwrite');
		tx.objectStore(STORE_BANKS).delete(id);
		const idx = tx.objectStore(STORE_SAMPLES).index('bankId');
		const cursorReq = idx.openKeyCursor(IDBKeyRange.only(id));
		cursorReq.onsuccess = () => {
			const cursor = cursorReq.result;
			if (cursor) {
				tx.objectStore(STORE_SAMPLES).delete(cursor.primaryKey);
				cursor.continue();
			}
		};
		await txDone(tx);
		if (getRememberedActiveId() === id) setRememberedActiveId(null);
	}

	async exportZip(
		id: string
	): Promise<{ filename: string; bytes: Uint8Array<ArrayBuffer> } | null> {
		const db = await this.openDb();
		if (!db) return null;
		const row = await promisify<StoredBankRow | undefined>(
			db.transaction(STORE_BANKS).objectStore(STORE_BANKS).get(id)
		).catch(() => undefined);
		if (!row) return null;

		const zip = new JSZip();
		const root = row.name.replace(/[\\/:*?"<>|]/g, '_') || 'voicebank';
		const folder = zip.folder(root)!;

		folder.file('oto.ini', row.oto);
		if (row.prefixMap) folder.file('prefix.map', row.prefixMap);

		const charLines = row.characterEntries.map(([k, v]) => `${k}=${v}`).join('\n');
		if (charLines) folder.file('character.txt', encodeText(charLines));
		if (row.imageBytes && row.characterEntries.find(([k]) => k === 'image')) {
			const imgName = row.characterEntries.find(([k]) => k === 'image')![1];
			folder.file(imgName, row.imageBytes);
		}

		for (const meta of row.samples) {
			const sRow = await promisify<StoredSampleRow | undefined>(
				db.transaction(STORE_SAMPLES).objectStore(STORE_SAMPLES).get(`${row.id}|${meta.key}`)
			);
			if (sRow) {
				const rel = meta.path.includes('/') ? meta.path.split('/').slice(1).join('/') : meta.path;
				folder.file(rel || meta.key, sRow.data);
			}
		}

		const bytes = (await zip.generateAsync({ type: 'uint8array' })) as Uint8Array<ArrayBuffer>;
		return { filename: `${root}.zip`, bytes };
	}
}

export const voicebankLibrary = new VoicebankLibrary();
