import { mountChart, type ChartHost, type DomChartDefinition } from "@tanstack/charts";
import { createEffect, onSettled } from "solid-js";

export interface ChartHostProps<TDatum> {
	readonly ariaLabel: string;
	readonly definition: DomChartDefinition<TDatum>;
	readonly height?: number;
}

/** Mount TanStack Charts through its framework-neutral DOM lifecycle. */
export function Chart<TDatum>(props: ChartHostProps<TDatum>) {
	let container: HTMLDivElement | undefined;
	let host: ChartHost<TDatum> | undefined;
	const options = () => ({
		ariaLabel: props.ariaLabel,
		definition: props.definition,
		height: props.height ?? 320
	});

	createEffect(options, (next) => {
		host?.update(next);
	});
	onSettled(() => {
		if (container === undefined) return;
		host = mountChart(container, options());
		return () => {
			host?.destroy();
			host = undefined;
		};
	});

	return (
		<div
			class="ts-chart-host"
			ref={(element) => {
				container = element;
			}}
			style={{ height: `${props.height ?? 320}px`, position: "relative", width: "100%" }}
		/>
	);
}
