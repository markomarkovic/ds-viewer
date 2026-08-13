import { render } from 'preact'
import { App } from './ui/App'
import '@picocss/pico/css/pico.min.css'
import 'uplot/dist/uPlot.min.css'
import './app.css'

const el = document.getElementById('app')
if (el) render(<App />, el)
