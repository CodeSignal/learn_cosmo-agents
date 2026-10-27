import "./app.css"
import { render } from "solid-js/web"
import { ThemeProvider } from "@opencode-ai/ui/theme/context"
import { App } from "./app"
import { start } from "./store"

start()

render(
  () => (
    // The design-system theme shared with OpenCosmo (light/dark follow the system).
    <ThemeProvider defaultTheme="cosmo">
      <App />
    </ThemeProvider>
  ),
  document.getElementById("root")!,
)
