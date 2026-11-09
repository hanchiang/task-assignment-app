// jsdom lacks <dialog>.showModal() and scrollIntoView. These stand-ins mimic what the tests rely on:
// showModal sets `open` and focuses the first control, as a browser does. Testing Library does not
// clean up on its own when Vitest globals are off.
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

const FOCUSABLE = "button, input, select, textarea, a[href], [tabindex]";

HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
  this.setAttribute("open", "");
  this.querySelector<HTMLElement>(FOCUSABLE)?.focus();
};
Element.prototype.scrollIntoView = () => {};

afterEach(cleanup);
