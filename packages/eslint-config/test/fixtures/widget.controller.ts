import { Injectable } from './nest-injectable.js';
import { WidgetService } from './nest-widget.service.js';

@Injectable()
export class WidgetController {
  constructor(private readonly widgets: WidgetService) {}

  read(): string {
    return this.widgets.getWidget();
  }
}
