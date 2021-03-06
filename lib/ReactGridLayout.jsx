// @flow
import React from "react";

import isEqual from "lodash.isequal";
import classNames from "classnames";
import {
  autoBindHandlers,
  bottom,
  childrenEqual,
  cloneLayoutItem,
  compact,
  getLayoutItem,
  moveElement,
  synchronizeLayoutWithChildren,
  getAllCollisions,
  compactType,
  noop,
  fastRGLPropsEqual
} from "./utils";

import { calcXY } from "./calculateUtils";

import GridItem from "./GridItem";
import ReactGridLayoutPropTypes from "./ReactGridLayoutPropTypes";
import type {
  ChildrenArray as ReactChildrenArray,
  Element as ReactElement
} from "react";

// Types
import type {
  CompactType,
  GridResizeEvent,
  GridDragEvent,
  Layout,
  DroppingPosition,
  LayoutItem
} from "./utils";

declare var Window: any;
import type { PositionParams } from "./calculateUtils";

type State = {
  id: string,
  activeDrag: ?LayoutItem,
  layout: Layout,
  mounted: boolean,
  oldDragItem: ?LayoutItem,
  oldLayout: ?Layout,
  oldResizeItem: ?LayoutItem,
  droppingDOMNode: ?ReactElement<any>,
  droppingPosition?: DroppingPosition,
  // Mirrored props
  children: ReactChildrenArray<ReactElement<any>>,
  compactType?: CompactType,
  propsLayout?: Layout
};

import type { Props } from "./ReactGridLayoutPropTypes";

// End Types

// https://gist.github.com/gordonbrander/2230317
const generateID = (): string => {
  return (
    "_" +
    Math.random()
      .toString(36)
      .substr(2, 9)
  );
};

const layoutClassName = "react-grid-layout";
let isFirefox = false;
// Try...catch will protect from navigator not existing (e.g. node) or a bad implementation of navigator
try {
  isFirefox = /firefox/i.test(navigator.userAgent);
} catch (e) {
  /* Ignore */
}

/**
 * A reactive, fluid grid layout with draggable, resizable components.
 */

export default class ReactGridLayout extends React.Component<Props, State> {
  // TODO publish internal ReactClass displayName transform
  static displayName = "ReactGridLayout";

  // Refactored to another module to make way for preval
  static propTypes = ReactGridLayoutPropTypes;

  static defaultProps = {
    autoSize: true,
    cols: 12,
    className: "",
    style: {},
    draggableHandle: "",
    draggableCancel: "",
    minHeight: 0,
    containerPadding: null,
    rowHeight: 150,
    maxRows: Infinity, // infinite vertical growth
    layout: [],
    margin: [10, 10],
    isDraggable: true,
    isResizable: true,
    isDroppable: false,
    useCSSTransforms: true,
    transformScale: 1,
    verticalCompact: true,
    compactType: "vertical",
    preventCollision: false,
    collisionDelay: 0,
    droppingItem: {
      i: "__dropping-elem__",
      h: 1,
      w: 1
    },
    onLayoutChange: noop,
    onDragStart: noop,
    onDrag: noop,
    onDragStop: noop,
    onResizeStart: noop,
    onResize: noop,
    onResizeStop: noop,
    onDrop: noop,
    debug: false
  };

  state: State = {
    id: "reactGrid" + generateID(),
    activeDrag: null,
    layout: synchronizeLayoutWithChildren(
      this.props.layout,
      this.props.children,
      this.props.cols,
      // Legacy support for verticalCompact: false
      compactType(this.props)
    ),
    mounted: false,
    oldDragItem: null,
    oldLayout: null,
    oldResizeItem: null,
    droppingDOMNode: null,
    children: []
  };

  dragEnterCounter = 0;
  dropZoneXY = [0, 0];

  delayedFunction = null;

  dragDebug = {};

  constructor(props: Props, context: any): void {
    super(props, context);
    autoBindHandlers(this, [
      "onDragStart",
      "onDrag",
      "onDragStop",
      "onResizeStart",
      "onResize",
      "onResizeStop"
    ]);
  }

  componentDidMount() {
    this.setState({ mounted: true });
    // Possibly call back with layout on mount. This should be done after correcting the layout width
    // to ensure we don't rerender with the wrong width.
    this.onLayoutMaybeChanged(this.state.layout, this.props.layout);

    // Add drag & drop events manually on the created DOM, rather than using react's event model.  This may
    // help avoid conflicts.
    if (this.props.isDroppable) {
      this.enableDropEvents();
    }
  }

  componentWillUnmount() {
    if (this.props.isDroppable) {
      this.disableDropEvents();
    }
  }

  static getDerivedStateFromProps(nextProps: Props, prevState: State) {
    let newLayoutBase;

    if (prevState.activeDrag) {
      return null;
    }

    // Legacy support for compactType
    // Allow parent to set layout directly.
    if (
      !isEqual(nextProps.layout, prevState.propsLayout) ||
      nextProps.compactType !== prevState.compactType
    ) {
      newLayoutBase = nextProps.layout;
    } else if (!childrenEqual(nextProps.children, prevState.children)) {
      // If children change, also regenerate the layout. Use our state
      // as the base in case because it may be more up to date than
      // what is in props.
      newLayoutBase = prevState.layout;
    }

    // We need to regenerate the layout.
    if (newLayoutBase) {
      const newLayout = synchronizeLayoutWithChildren(
        newLayoutBase,
        nextProps.children,
        nextProps.cols,
        compactType(nextProps)
      );

      return {
        layout: newLayout,
        // We need to save these props to state for using
        // getDerivedStateFromProps instead of componentDidMount (in which we would get extra rerender)
        compactType: nextProps.compactType,
        children: nextProps.children,
        propsLayout: nextProps.layout
      };
    }

    return null;
  }

  shouldComponentUpdate(nextProps: Props, nextState: State) {
    return (
      // NOTE: this is almost always unequal. Therefore the only way to get better performance
      // from SCU is if the user intentionally memoizes children. If they do, and they can
      // handle changes properly, performance will increase.
      this.props.children !== nextProps.children ||
      !fastRGLPropsEqual(this.props, nextProps, isEqual) ||
      this.state.activeDrag !== nextState.activeDrag ||
      this.state.droppingPosition !== nextState.droppingPosition
    );
  }

  componentDidUpdate(prevProps: Props, prevState: State) {
    if (!this.state.activeDrag) {
      const newLayout = this.state.layout;
      const oldLayout = prevState.layout;

      this.onLayoutMaybeChanged(newLayout, oldLayout);

      if (prevProps.isDroppable !== this.props.isDroppable) {
        if (this.props.isDroppable) {
          this.enableDropEvents();
        } else {
          this.disableDropEvents();
        }
      }
    }
  }

  enableDropEvents() {
    var rootDOM: HTMLElement | null = document.getElementById(this.state.id);
    if (rootDOM != null) {
      rootDOM.addEventListener("drop", this.onDrop);
      rootDOM.addEventListener("dragover", this.onDragOver);
      rootDOM.addEventListener("dragleave", this.onDragLeave);
      rootDOM.addEventListener("dragenter", this.onDragEnter);
    }
  }

  disableDropEvents() {
    var rootDOM: HTMLElement | null = document.getElementById(this.state.id);
    if (rootDOM != null) {
      rootDOM.removeEventListener("drop", this.onDrop);
      rootDOM.removeEventListener("dragover", this.onDragOver);
      rootDOM.removeEventListener("dragleave", this.onDragLeave);
      rootDOM.removeEventListener("dragenter", this.onDragEnter);
    }
  }

  /**
   * Calculates a pixel value for the container.
   * @return {String} Container height in pixels.
   */
  containerHeight() {
    if (!this.props.autoSize) return;
    const nbRow = bottom(this.state.layout);
    const containerPaddingY = this.props.containerPadding
      ? this.props.containerPadding[1]
      : this.props.margin[1];
    const calcHeight =
      nbRow * this.props.rowHeight +
      (nbRow - 1) * this.props.margin[1] +
      containerPaddingY * 2;

    return (
      (this.props.minHeight !== 0 && calcHeight < this.props.minHeight
        ? this.props.minHeight
        : calcHeight) + "px"
    );
  }

  /**
   * When dragging starts
   * @param {String} i Id of the child
   * @param {Number} x X position of the move
   * @param {Number} y Y position of the move
   * @param {Event} e The mousedown event
   * @param {Element} node The current dragging DOM element
   */
  onDragStart(i: string, x: number, y: number, { e, node }: GridDragEvent) {
    const { layout } = this.state;
    var l = getLayoutItem(layout, i);
    if (!l) return;

    this.setState({
      oldDragItem: cloneLayoutItem(l),
      oldLayout: this.state.layout
    });

    return this.props.onDragStart(layout, l, l, null, e, node);
  }

  /**
   * Each drag movement create a new dragelement and move the element to the dragged location
   * @param {String} i Id of the child
   * @param {Number} x X position of the move
   * @param {Number} y Y position of the move
   * @param {Event} e The mousedown event
   * @param {Element} node The current dragging DOM element
   */
  onDrag(i: string, x: number, y: number, { e, node }: GridDragEvent) {
    const { oldDragItem } = this.state;
    let { layout } = this.state;
    const { cols } = this.props;
    var l = getLayoutItem(layout, i);
    if (!l) return;

    // Create placeholder (display only)
    var placeholder = {
      w: l.w,
      h: l.h,
      x: l.x,
      y: l.y,
      placeholder: true,
      i: i
    };

    // Move the element to the dragged location.
    const isUserAction = true;
    layout = moveElement(
      layout,
      l,
      x,
      y,
      isUserAction,
      this.props.preventCollision,
      compactType(this.props),
      cols,
      this.props.collisionDelay !== 0
        ? () => {
            return setTimeout(() => {
              moveElement(
                layout,
                l,
                x,
                y,
                isUserAction,
                this.props.preventCollision,
                compactType(this.props),
                cols
              );
              Window.rglCollisionDelayObj = null;

              this.props.onDrag(layout, oldDragItem, l, placeholder, e, node);

              this.setState({
                layout: compact(layout, compactType(this.props), cols),
                activeDrag: placeholder
              });
            }, this.props.collisionDelay);
          }
        : undefined
    );

    this.props.onDrag(layout, oldDragItem, l, placeholder, e, node);

    this.setState({
      layout: compact(layout, compactType(this.props), cols),
      activeDrag: placeholder
    });
  }

  /**
   * When dragging stops, figure out which position the element is closest to and update its x and y.
   * @param  {String} i Index of the child.
   * @param {Number} x X position of the move
   * @param {Number} y Y position of the move
   * @param {Event} e The mousedown event
   * @param {Element} node The current dragging DOM element
   */
  onDragStop(i: string, x: number, y: number, { e, node }: GridDragEvent) {
    if (!this.state.activeDrag) return;

    const { oldDragItem } = this.state;
    let { layout } = this.state;
    const { cols, preventCollision } = this.props;
    const l = getLayoutItem(layout, i);
    if (!l) return;

    // Move the element here
    const isUserAction = true;
    layout = moveElement(
      layout,
      l,
      x,
      y,
      isUserAction,
      preventCollision,
      compactType(this.props),
      cols,
      this.props.collisionDelay !== 0
        ? () => {
            return setTimeout(() => {
              moveElement(
                layout,
                l,
                x,
                y,
                isUserAction,
                this.props.preventCollision,
                compactType(this.props),
                cols
              );
              Window.rglCollisionDelayObj = null;

              if (this.state.activeDrag) {
                this.props.onDragStop(layout, oldDragItem, l, null, e, node);
              }

              // Set state
              const newLayout = compact(layout, compactType(this.props), cols);
              const { oldLayout } = this.state;
              this.setState({
                activeDrag: null,
                layout: newLayout,
                oldDragItem: null,
                oldLayout: null
              });

              this.onLayoutMaybeChanged(newLayout, oldLayout);
            }, this.props.collisionDelay);
          }
        : undefined
    );

    this.props.onDragStop(layout, oldDragItem, l, null, e, node);

    // Set state
    const newLayout = compact(layout, compactType(this.props), cols);
    const { oldLayout } = this.state;
    this.setState({
      activeDrag: null,
      layout: newLayout,
      oldDragItem: null,
      oldLayout: null
    });

    this.onLayoutMaybeChanged(newLayout, oldLayout);
  }

  onLayoutMaybeChanged(newLayout: Layout, oldLayout: ?Layout) {
    if (!oldLayout) oldLayout = this.state.layout;

    if (!isEqual(oldLayout, newLayout)) {
      this.props.onLayoutChange(newLayout);
    }
  }

  onResizeStart(i: string, w: number, h: number, { e, node }: GridResizeEvent) {
    const { layout } = this.state;
    var l = getLayoutItem(layout, i);
    if (!l) return;

    this.setState({
      oldResizeItem: cloneLayoutItem(l),
      oldLayout: this.state.layout
    });

    this.props.onResizeStart(layout, l, l, null, e, node);
  }

  onResize(i: string, w: number, h: number, { e, node }: GridResizeEvent) {
    const { layout, oldResizeItem } = this.state;
    const { cols, preventCollision } = this.props;
    const l: ?LayoutItem = getLayoutItem(layout, i);
    if (!l) return;

    // Something like quad tree should be used
    // to find collisions faster
    let hasCollisions;
    if (preventCollision) {
      const collisions = getAllCollisions(layout, { ...l, w, h }).filter(
        layoutItem => layoutItem.i !== l.i
      );
      hasCollisions = collisions.length > 0;

      // If we're colliding, we need adjust the placeholder.
      if (hasCollisions) {
        // adjust w && h to maximum allowed space
        let leastX = Infinity,
          leastY = Infinity;
        collisions.forEach(layoutItem => {
          if (layoutItem.x > l.x) leastX = Math.min(leastX, layoutItem.x);
          if (layoutItem.y > l.y) leastY = Math.min(leastY, layoutItem.y);
        });

        if (Number.isFinite(leastX)) l.w = leastX - l.x;
        if (Number.isFinite(leastY)) l.h = leastY - l.y;
      }
    }

    if (!hasCollisions) {
      // Set new width and height.
      l.w = w;
      l.h = h;
    }

    // Create placeholder element (display only)
    var placeholder = {
      w: l.w,
      h: l.h,
      x: l.x,
      y: l.y,
      static: true,
      i: i
    };

    this.props.onResize(layout, oldResizeItem, l, placeholder, e, node);

    // Re-compact the layout and set the drag placeholder.
    this.setState({
      layout: compact(layout, compactType(this.props), cols),
      activeDrag: placeholder
    });
  }

  onResizeStop(i: string, w: number, h: number, { e, node }: GridResizeEvent) {
    const { layout, oldResizeItem } = this.state;
    const { cols } = this.props;
    var l = getLayoutItem(layout, i);

    this.props.onResizeStop(layout, oldResizeItem, l, null, e, node);

    // Set state
    const newLayout = compact(layout, compactType(this.props), cols);
    const { oldLayout } = this.state;
    this.setState({
      activeDrag: null,
      layout: newLayout,
      oldResizeItem: null,
      oldLayout: null
    });

    this.onLayoutMaybeChanged(newLayout, oldLayout);
  }

  /**
   * Create a placeholder object.
   * @return {Element} Placeholder div.
   */
  placeholder(): ?ReactElement<any> {
    const { activeDrag } = this.state;
    if (!activeDrag) return null;
    const {
      width,
      cols,
      margin,
      containerPadding,
      rowHeight,
      maxRows,
      useCSSTransforms,
      transformScale
    } = this.props;

    // {...this.state.activeDrag} is pretty slow, actually
    return (
      <GridItem
        w={activeDrag.w}
        h={activeDrag.h}
        x={activeDrag.x}
        y={activeDrag.y}
        i={activeDrag.i}
        className="react-grid-placeholder"
        containerWidth={width}
        cols={cols}
        margin={margin}
        containerPadding={containerPadding || margin}
        maxRows={maxRows}
        rowHeight={rowHeight}
        isDraggable={false}
        isResizable={false}
        useCSSTransforms={useCSSTransforms}
        transformScale={transformScale}
      >
        <div />
      </GridItem>
    );
  }

  /**
   * Given a grid item, set its style attributes & surround in a <Draggable>.
   * @param  {Element} child React element.
   * @return {Element}       Element wrapped in draggable and properly placed.
   */
  processGridItem(
    child: ReactElement<any>,
    isDroppingItem?: boolean
  ): ?ReactElement<any> {
    if (!child || !child.key) return;
    const l = getLayoutItem(this.state.layout, String(child.key));
    if (!l) return null;
    const {
      width,
      cols,
      margin,
      containerPadding,
      rowHeight,
      maxRows,
      isDraggable,
      isResizable,
      useCSSTransforms,
      transformScale,
      draggableCancel,
      draggableHandle
    } = this.props;
    const { mounted, droppingPosition } = this.state;

    // Determine user manipulations possible.
    // If an item is static, it can't be manipulated by default.
    // Any properties defined directly on the grid item will take precedence.
    const draggable =
      typeof l.isDraggable === "boolean"
        ? l.isDraggable
        : !l.static && isDraggable;
    const resizable =
      typeof l.isResizable === "boolean"
        ? l.isResizable
        : !l.static && isResizable;

    return (
      <GridItem
        containerWidth={width}
        cols={cols}
        margin={margin}
        containerPadding={containerPadding || margin}
        maxRows={maxRows}
        rowHeight={rowHeight}
        cancel={draggableCancel}
        handle={draggableHandle}
        onDragStop={this.onDragStop}
        onDragStart={this.onDragStart}
        onDrag={this.onDrag}
        onResizeStart={this.onResizeStart}
        onResize={this.onResize}
        onResizeStop={this.onResizeStop}
        isDraggable={draggable}
        isResizable={resizable}
        useCSSTransforms={useCSSTransforms && mounted}
        usePercentages={!mounted}
        transformScale={transformScale}
        w={l.w}
        h={l.h}
        x={l.x}
        y={l.y}
        i={l.i}
        minH={l.minH}
        minW={l.minW}
        maxH={l.maxH}
        maxW={l.maxW}
        static={l.static}
        droppingPosition={isDroppingItem ? droppingPosition : undefined}
      >
        {child}
      </GridItem>
    );
  }

  // Called while dragging an element. Part of browser native drag/drop API.
  // Native event target might be the layout itself, or an element within the layout.
  onDragOver = (e: any) => {
    this.debugBox(
      2,
      JSON.stringify({
        dropZoneX: this.dropZoneXY[0],
        dropZoneY: this.dropZoneXY[1],
        clientX: e.clientX,
        clientY: e.clientY,
        finalX: e.clientX - this.dropZoneXY[0],
        finalY: e.clientY - this.dropZoneXY[1],
        target: e.target
          ? e.target.nodeName + "(" + e.target.className + ")#" + e.target.id
          : ""
      })
    );

    const {
      droppingItem,
      margin,
      cols,
      rowHeight,
      maxRows,
      width,
      containerPadding
    } = this.props;
    const { layout } = this.state;
    const clientX = e.clientX - this.dropZoneXY[0];
    const clientY = e.clientY - this.dropZoneXY[1];
    const droppingPosition = { left: clientX, top: clientY, e };

    if (!this.state.droppingDOMNode) {
      const positionParams: PositionParams = {
        cols,
        margin,
        maxRows,
        rowHeight,
        containerWidth: width,
        containerPadding: containerPadding || margin
      };

      const calculatedPosition = calcXY(
        positionParams,
        clientY,
        clientX,
        droppingItem.w,
        droppingItem.h
      );

      this.setState({
        droppingDOMNode: <div key={droppingItem.i} />,
        droppingPosition,
        layout: [
          ...layout,
          {
            ...droppingItem,
            x: calculatedPosition.x,
            y: calculatedPosition.y,
            static: false,
            isDraggable: true
          }
        ]
      });
    } else if (this.state.droppingPosition) {
      const { left, top } = this.state.droppingPosition;
      const shouldUpdatePosition = left != clientX || top != clientY;
      if (shouldUpdatePosition) {
        this.setState({ droppingPosition });
      }
    }

    e.stopPropagation();
    e.preventDefault();
  };

  removeDroppingPlaceholder = (compactAfter?: boolean) => {
    const { droppingItem, cols } = this.props;
    const { layout } = this.state;

    var newLayout = [];

    if (compactAfter) {
      newLayout = compact(
        layout.filter(l => l.i !== droppingItem.i),
        compactType(this.props),
        cols
      );
    } else {
      newLayout = layout.filter(l => l.i !== droppingItem.i);
    }

    this.setState({
      layout: newLayout,
      droppingDOMNode: null,
      activeDrag: null,
      droppingPosition: undefined
    });
  };

  onDragLeave = () => {
    this.dragEnterCounter--;

    // onDragLeave can be triggered on each layout's child.
    // But we know that count of dragEnter and dragLeave events
    // will be balanced after leaving the layout's container
    // so we can increase and decrease count of dragEnter and
    // when it'll be equal to 0 we'll remove the placeholder
    if (this.dragEnterCounter === 0) {
      this.removeDroppingPlaceholder(true);
    }
    this.debugBox(1, this.dragEnterCounter.toString());
  };

  onDragEnter = () => {
    var gridContainerDims = (document.getElementById(
      this.state.id
    ): any).getBoundingClientRect();
    this.dragEnterCounter++;
    this.dropZoneXY = [gridContainerDims.left, gridContainerDims.top];
    this.debugBox(1, this.dragEnterCounter.toString());
  };

  onDrop = (e: Event) => {
    const { droppingItem } = this.props;
    const { layout } = this.state;
    const { x, y, w, h } = layout.find(l => l.i === droppingItem.i) || {};

    // reset gragEnter counter on drop
    this.dragEnterCounter = 0;

    this.removeDroppingPlaceholder();

    this.props.onDrop({ x, y, w, h, e });
  };

  debugBox(boxNo: number, boxText: string) {
    if (this.props.debug) {
      (document.getElementById(
        this.state.id + "-debug-box" + boxNo
      ): any).innerText = boxText;
    }
  }

  render() {
    const { className, style, isDroppable } = this.props;

    const mergedClassName = classNames(layoutClassName, className);
    const mergedStyle = {
      height: this.containerHeight(),
      ...style
    };

    return (
      <>
        <div id={this.state.id} className={mergedClassName} style={mergedStyle}>
          {React.Children.map(this.props.children, child =>
            this.processGridItem(child)
          )}
          {isDroppable &&
            this.state.droppingDOMNode &&
            this.processGridItem(this.state.droppingDOMNode, true)}
          {this.placeholder()}
        </div>
        {this.props.debug && (
          <div
            style={{
              backgroundColor: "#0000ff",
              color: "#ffffff",
              wordBreak: "break-all"
            }}
          >
            <div id={this.state.id + "-debug-box1"}></div>
            <div id={this.state.id + "-debug-box2"}></div>
            <div id={this.state.id + "-debug-box3"}></div>
            <div id={this.state.id + "-debug-box4"}></div>
            <div id={this.state.id + "-debug-box5"}></div>
            {JSON.stringify(
              this.state.layout.map(item => {
                return { i: item.i, x: item.x, y: item.y };
              })
            )}
          </div>
        )}
      </>
    );
  }
}
