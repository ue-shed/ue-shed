import { configure } from "@solidjs/testing-library";
import { flush } from "solid-js";

// fireEvent dispatches synchronously; settle Solid's microtask batch between simulated browser events.
configure({
	eventWrapper: (dispatch) => {
		const result = dispatch();
		flush();
		return result;
	}
});
