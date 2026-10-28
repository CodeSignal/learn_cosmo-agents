import "./app.css"
import { render } from "solid-js/web"
import { ThemeProvider } from "@opencode-ai/ui/theme/context"
import { App } from "./app"
import { start } from "./store"
import { applyPrefs } from "./prefs"

applyPrefs()
start()

render(
  () => (
    // The design-system theme shared with OpenCosmo; light or dark follows the platform's theme.
    <ThemeProvider defaultTheme="cosmo" followSystem>
      <App />
    </ThemeProvider>
  ),
  document.getElementById("root")!,
)
