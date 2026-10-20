import { Button } from "@shoal/ui/components/button";
import { Input } from "@shoal/ui/components/input";
import { type FormEvent, type KeyboardEvent, useEffect, useId, useState } from "react";
import { bytes } from "../shared/format";
import type { ModelQuant, ModelSearchResult } from "../shared/rpc";
import { rpc } from "./rpc";

const SEARCH_DELAY_MS = 300;
/** llama.cpp's own default for `-hf` without a tag. */
const DEFAULT_QUANT = "Q4_K_M";

/** Searches Hugging Face for GGUF repos, then offers the chosen repo's quantizations. */
export function ModelPicker({ onDownload }: { onDownload: (model: string) => Promise<void> }) {
	const listId = useId();
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<ReadonlyArray<ModelSearchResult>>([]);
	const [highlighted, setHighlighted] = useState(0);
	const [repo, setRepo] = useState<string | null>(null);
	const [quants, setQuants] = useState<ReadonlyArray<ModelQuant> | null>(null);
	const [quant, setQuant] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		const term = query.trim();
		if (repo !== null || term.length < 2) {
			setResults([]);
			return;
		}
		let live = true;
		const timer = setTimeout(async () => {
			const found = await rpc.request.searchModels({ query: term }).catch((e: Error) => {
				setError(e.message);
				return [];
			});
			if (!live) return;
			setResults(found);
			setHighlighted(0);
		}, SEARCH_DELAY_MS);
		return () => {
			live = false;
			clearTimeout(timer);
		};
	}, [query, repo]);

	const choose = async (id: string) => {
		setRepo(id);
		setQuery(id);
		setResults([]);
		setQuants(null);
		setError(null);
		const offered = await rpc.request.modelQuants({ repo: id }).catch((e: Error) => {
			setError(e.message);
			return [];
		});
		setQuants(offered);
		setQuant(offered.find((q) => q.tag.toUpperCase() === DEFAULT_QUANT)?.tag ?? offered[0]?.tag ?? null);
	};

	const reset = (text: string) => {
		setQuery(text);
		setRepo(null);
		setQuants(null);
		setQuant(null);
	};

	const onKeyDown = (event: KeyboardEvent) => {
		if (results.length === 0) return;
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const step = event.key === "ArrowDown" ? 1 : -1;
			setHighlighted((i) => (i + step + results.length) % results.length);
		} else if (event.key === "Enter") {
			event.preventDefault();
			void choose(results[highlighted].id);
		} else if (event.key === "Escape") {
			setResults([]);
		}
	};

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (repo === null) return;
		await onDownload(quant ? `${repo}:${quant}` : repo);
		reset("");
	};

	return (
		<form onSubmit={submit} className="flex flex-col gap-2">
			<div className="relative flex gap-2">
				<Input
					role="combobox"
					aria-expanded={results.length > 0}
					aria-controls={listId}
					aria-activedescendant={results.length > 0 ? `${listId}-${highlighted}` : undefined}
					value={query}
					onChange={(e) => reset(e.target.value)}
					onKeyDown={onKeyDown}
					placeholder="Search Hugging Face for a GGUF model"
					className="flex-1 font-mono"
					autoComplete="off"
				/>
				<Button type="submit" variant="outline" disabled={repo === null || quants === null}>
					Download
				</Button>
				{results.length > 0 && (
					<ul
						id={listId}
						role="listbox"
						className="absolute top-full right-0 left-0 z-10 m-0 mt-1 list-none overflow-hidden rounded-[9px] border border-line-strong bg-shelf p-0"
					>
						{results.map((result, index) => (
							<li
								key={result.id}
								id={`${listId}-${index}`}
								role="option"
								aria-selected={index === highlighted}
								onMouseEnter={() => setHighlighted(index)}
								onMouseDown={(e) => {
									// Before the input blurs, so the click lands.
									e.preventDefault();
									void choose(result.id);
								}}
								className="flex cursor-pointer items-center gap-3 px-3.5 py-2 aria-selected:bg-lumen-wash"
							>
								<span className="min-w-0 flex-1 truncate font-mono text-[13px]">{result.id}</span>
								<span className="text-xs text-silt">{result.downloads.toLocaleString()} downloads</span>
							</li>
						))}
					</ul>
				)}
			</div>
			{repo !== null && quants === null && <p className="m-0 text-xs text-silt">Reading {repo}…</p>}
			{quants?.length === 0 && <p className="m-0 text-xs text-silt">No quantizations found; llama.cpp will pick a file.</p>}
			{quants && quants.length > 0 && (
				<div role="radiogroup" aria-label="Quantization" className="flex flex-wrap gap-1.5">
					{quants.map((q) => (
						<Button
							key={q.tag}
							type="button"
							role="radio"
							aria-checked={q.tag === quant}
							variant={q.tag === quant ? "default" : "outline"}
							size="xs"
							onClick={() => setQuant(q.tag)}
						>
							{q.tag} · {bytes(q.bytes)}
						</Button>
					))}
				</div>
			)}
			{error && (
				<p role="alert" className="m-0 text-sm text-coral">
					{error}
				</p>
			)}
		</form>
	);
}
