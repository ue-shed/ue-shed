import { render } from "@solidjs/web";
import { App } from "./App.js";
import "./reset.css";

const root = document.getElementById("root");

if (root) {
	render(() => <App />, root);
}
