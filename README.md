# tiny-reactive-dataflow

A tiny reactive dataflow library for asynchronously scheduling a Directed Acyclic Graph (DAG) of functions in Javascript.

Tiny-reactive-dataflow works similarly to React's state change propagation algorithm; however, tiny-reactive-dataflow is significantly simpler and easier to use, and is even arguably more powerful than React.

Tiny-reactive-dataflow allows changes to values to be propagated through a DAG of nodes, with each node corresponding to a Javascript function. Once the most recent values of all upstream dependencies have all been computed, each function is scheduled for asynchronous execution, then the result value of the function is cached as the new value of the function's dataflow node.

This library is designed for maximum efficiency: changes are only propagated further downstream if the output value of a function changes, and function execution is scheduled with maximum concurrency (via `Promise.allSettled`), while respecting the partial ordering of dependencies between nodes.

The dataflow graph can be connected to the DOM with a single function call, allowing DOM input events to push values into the dataflow graph, and outputs from the dataflow graph to automatically update the DOM.

### Basic usage example

After sourcing [Lodash](https://lodash.com/) (the only dependency, used for [object comparisons](https://lodash.com/docs#isEqual)) and [`tiny-reactive-dataflow.js`](https://github.com/lukehutch/tiny-reactive-dataflow/blob/main/tiny-reactive-dataflow.js):

```javascript
dataflow.register({
    a: (x, y) => x + y,
    b: (a, c) => a * c,
    c: (z) => z * 2,
    d: (b) => b * b
});

(async () => {
    DEBUG_DATAFLOW = true;
    await dataflow.set({x: 1, y: 2, z: 3});
    await dataflow.set({x: 2});
    await dataflow.set({c: 1});
    console.log("d: " + dataflow.value.d);
})();
```

This produces the following output:

```
Setting: x = 1
Setting: y = 2
Setting: z = 3
Calling: a(1,2)
Calling: c(3)
Setting: a = 3
Setting: c = 6
Calling: b(3,6)
Setting: b = 18
Calling: d(18)
Setting: d = 324
Dataflow ended
Setting: x = 2
Calling: a(2,2)
Setting: a = 4
Calling: b(4,6)
Setting: b = 24
Calling: d(24)
Setting: d = 576
Dataflow ended
Setting: c = 1
Calling: b(4,1)
Setting: b = 4
Calling: d(4)
Setting: d = 16
Dataflow ended
d: 16
```

## Background

### What is reactive programming?

The simplest example of reactive programming is the spreadsheet model: in a spreadsheet, if cell B1 contains a formula that depends upon A1, such as `A1+1`, then cell B1 is automatically recomputed and updated every time the value in A1 is changed.

It is not possible to create a directed cycle of such dependencies between cells in a spreadsheet without the spreadsheet program will reporting an error. Therefore, all dependencies between cells in a spreadsheet are structured as a DAG (Directed Acyclic Graph).

### What is dataflow?

All computation is fundamentally DAG-structured, consisting of *edges*, which are data dependencies between values, and *nodes*, representing both a function and the result of computing that function on specific inputs to produce the value at the node.

All models of computation, including imperative, functional, event-driven, parallel, serial, and even spaghetti code, can be unrolled into its computational DAG by observing what values are computed from what other values at runtime, and drawing that out as a DAG.

All edges in a computational DAG must follow the arrow of time: upstream values must be available before they can be used as dependencies to compute downstream values. Therefore, all computational DAGs represent *partial orderings*, and any execution plan, parallel or single-threaded, that complies with this partial ordering allows the final value(s) to be computed.

### Features of the tiny-reactive-dataflow library

The tiny-reactive-dataflow library implements some powerful features in a very small Javascript codebase:

* Standard Javascript function syntax is used to create the nodes of the dataflow graph, with the name of each registered function creating a dataflow node of the same name. The names of the parameters of each function are automatically used to connect each node to its upstream dependencies, which are the result values of the functions of the same name as each parameter.
* Whenever an upstream node in the graph is set to a new value, changes are propagated through the dataflow graph completely asynchronously.
  * This is accomplished by propagating a "wavefront" of dirty nodes through the dataflow graph, starting from upstream nodes that were newly set.
  * All nodes in the active wavefront are computed with the maximum concurrency allowable under Javascript's asynchronous computing model, by using `Promises.all` to resolve all promises in the wavefront during each step of change propagation.
  * The wavefront progresses to downstream nodes only as all upstream dependencies of each downstream node have been resolved.
* The library is fully reactive.
  * Dependencies are specified using a "pull model" (a function depends upon, or pulls from, its parameters), but computation is driven using a "push model", with changes propagating from upstream nodes to downstream nodes.
* Changes may be made to multiple upstream nodes simultaneously, establishing the initial wavefront for change propagation, and allowing multiple inputs to a function to be changed atomically.
* Changes are only pushed through the transitive closure (set of reachable nodes) from a given change to the point where the computed value does not differ from the current cached value for that node. In other words, the implemented reactivity computes only the *minimal change set* for a given change or set of changes.
* *Dynamic dataflow* is supported: any of the nodes in the dataflow DAG may schedule changes to node values at any time, which effectively adds a temporary edge to the dataflow graph (see below).

## Usage

### Overview

Create all dataflow nodes as (optionally `async`) functions, or as "named lambdas", and register them:

```javascript
// Function syntax:

function add(x, y) {   // Causes node `add` to depend upon node `x` and node `y`
    return x + y;
}

function sub(x, y) {
    return x - y;
}

dataflow.register(add, sub);
```

Function names are used as node names. Function parameter names refer to the node names of upstream dependencies. If the named upstream dependency does not correspond to any function name (e.g. `x` and `y` in this example), then it is used as an input parameter that seeds changes into the dataflow DAG. You may call `register` as many times as you want to register additional functions.

Functions can also be registered using named lambda syntax:

```javascript
dataflow.register({
    add: (x, y) => x + y,
    sub: (x, y) => x - y
});
```

It is preferable to use this named lambda form, because it will be easier to find cases where you accidentally forgot to add a parameter name for a needed dependency if there aren't functions declared in the global scope with the same name as desired dependencies.

**Important:** You cannot allow your Javascript code to be minified, or function names and parameter names will be shortened, and will no longer correspond with each other, so your dataflow graph will be broken.

Note that since parameter names in a dataflow function exactly match the names of upstream functions, you must declare all dependencies in the parameter list of each function you define. These parameter names mask the names of the functions of the same name that they refer to. If you forget to specify a dependency as a parameter, you will be operating on the function of that name instead:

```javascript
function wrong(z) {
    // `sum` wrongly refers to the `sum` function itself (sum is not listed as a param)
    return sum + z;
}

function right(z, sum) {
    // Here `sum` correctly refers to the result of the `sum()` function
    return sum + z;
}
```

`dataflow.set({nodeName: newValue, ...})` is used to set one or more upstream parameters, named in the keys, to the corresponding value. This starts the process of reactive change propagation.

```javascript
dataflow.set({x: 1, y: 2});
```

If you want to wait for the changes you have set to finish propagating through the dataflow graph, then you can `await` the result of `set`. (However this is not necessary, if you're not interested in being notified of completion.)

```javascript
await dataflow.set({x: 1, y: 2});
```

Cached values of nodes can be obtained via `dataflow.value.nodeName`. If you are reading these values directly rather than listening for changes in a function in the dataflow graph, then you should `await` the completion of any `set` operations before you read from `dataflow.value`, so that you know you have the final value.

```javascript
await dataflow.set({input0: a, input1: b});
console.log("Result: " + dataflow.value.result);
```

You can also call `set` with an empty update to simply wait for dataflow change propagation to complete and for the dataflow network to settle before you read values from `dataflow.values`:

```javascript
await dataflow.set({});
console.log("Result: " + dataflow.value.nodeName);
```

Alternatively you can call `await get(nodeName)`, which accomplishes the same thing.

An error will be thrown at runtime, during a `set` call, if a directed cycle of dependencies is detected between dataflow nodes.

### Error handling

If any of the dataflow node functions threw an error when they were run, these will be stored in `dataflow.errors`, rather than being rethrown. You should only read this field after `await`ing the result of a `set` operation. Note that errors prevent dataflow propagating beyond the node that throws the error.

```javascript
await dataflow.set({inputVal: 0});
if (dataflow.errors.length > 0) {
    for (const err of dataflow.errors) {
        // Available values:
        //     err.functionName    The name of the dataflow node function that threw the error
        //     err.functionParams  The input parameters to the function call
        //     err.reason          The Error object
    }
}
```

### Undefined or invalid inputs

If upstream inputs are not set, they will be returned as `undefined`. Therefore, you may want to gracefully handle the situation where not all values are available to compute a function, by propagating `undefined` further down the DAG, using logic like the following. Because changes are only propagated if the cached return value of a function changes, this ensures that changes won't propagate until all parameters are available (since a "change" of `undefined` to `undefined` stops further propagation). In the following example, this avoids propagating `NaN` down the DAG from this function, since `undefined + undefined == NaN` in Javascript:

```javascript
function sum(x, y) {
    return x !== undefined && y !== undefined ? x + y : undefined;
}
```

You can also use this pattern to validate inputs coming in from the DOM (see below): if the input is not in the correct form, simply return `undefined` to prevent the invalid value being passed through the DAG. You will need to check downstream if the value is `undefined`, but at least no further changes will be propagated until the input is fixed so that the value becomes valid.

### Async function calls

Any function in the DAG may `await` an `async` function call, even a call to async functions that are not part of the dataflow DAG. Once the promise returned by that function resolves, change propagation through the DAG will resume from that point. While that promise is pending, changes may continue propagating through other nodes in the DAG. 

```javascript
async function resource() {
    return await fetch(url);
}
```

Maximal concurrency is achieved by using `Promise.allSettled` to await a wavefront of possibly-asynchronous function calls propagating through the dataflow DAG.

### External state change triggers

If a function needs to recompute something based on an external trigger, this can be represented by simply adding a parameter of a given name (that doesn't even need to be used by the function), and then setting that parameter to a new value each time the async function should be triggered to run.

For the following example, `resource` is fetched from `url` every 60 seconds, and the new content of `resource` is compared with the old value cached for the `resource` node. Only if the resource hosted at `url` changes will the downstream dependencies of `resource` be notified of the change.

```javascript
setInterval(() => dataflow.set({ timerTrigger: Date.now() }), 60000);

async function resource(timerTrigger) {
    return await fetch(url);
}
```

### Dynamic dataflow

Any function in the dataflow DAG may call `dataflow.set` to set any other value in the dataflow graph. This `set` operation is scheduled in a queue of update batches, and batches are only removed from the queue after the previous batch of changes has been fully propagated. Calling `set` from within a dataflow node's function therefore effectively adds a temporary data dependency to the DAG, or more accurately, to the graph induced by unrolling multiple copies of the dataflow DAG over time, to show the entire dataflow trace of the program over time (i.e. adding this temporary edge to the DAG cannot create a cycle, because it only applies the change to a future batch for change propagation in a subsequent dataflow pass).

Be aware that calling `dataflow.set` from a dataflow node function may trigger an infinite cycle of dataflow node updates, e.g. if you set an upstream dataflow dependency to a value that increments each time it is set.

### Multiple "push" outputs from a given function

The standard function notification allows functions depend upon upstream inputs as "pull" dependencies. However, a function can also generate any number of "push" outputs, using the dynamic dataflow feature described above.

```javascript
async function multiOutputs(input) {
    dataflow.set({
        output1: await function1(input),
        output2: await function2(input),
        output3: await function3(input)
    });
    return await function0(input);
}

// Then other functions can then depend upon output1, output2, and output3
// by specifying them as parameters.
```

Be aware however that any values you set in this way will be processed in a subsequent dataflow batch (i.e. a separate pass through the DAG), not the current batch.

Note that if a function does not have a `return` statement, it will always return `undefined`, which means it is a terminal (dowstream-most) node in the dataflow DAG, and no changes can be propagated beyond this node, unless it uses push outputs of the form shown above.

### Temporarily overriding computed changes

`dataflow.set` can actually be used to set the value of any node in the DAG, overriding the cached value at that node, and restarting change propagation from that point. If the named node corresponds to a function, calling `dataflow.set({functionName: newValue})` overwrites the cached output value of that function that was computed using the values of its most recent upstream dependencies. This overridden value will be itself overridden again if the function is recomputed due the value of its upstream dependencies changing.

### Connecting dataflow to the HTML DOM

Call the following function in your Javascript `DOMContentLoaded` handler after registering your async functions, if you want the dataflow graph to be driven by the DOM, and/or if you want to be able to trigger changes to the DOM based on dataflow outputs.

```javascript
dataflow.connectToDOM();
```

#### DOM to dataflow:

You can then drive changes into dataflow nodes from `<input>` elements as follows:

```html
<input type="text" to-dataflow-on-change="someValue_in">
```

when a `change` event is fired for this `<input>` element, this will cause the dataflow graph input named `someValue_in` to be set to the value of this element's `value` attribute. If the `<input>` element is of type `radio` or `checkbox`, then the `checked` attribute will be set rather than the `value` attribute. `someValue_in` must be a valid Javascript symbol name. (The `_in` suffix is just a convention to make the purpose of this dataflow node clear.)

To receive the value from the DOM, simply add `someValue_in` as a parameter to a dataflow function:

```javascript
function sanitizedValue(someValue_in) {
    return sanitize(someValue_in);
}
```

You can instead specify the attribute `to-dataflow-on-input` to respond to `input` events rather than `change` events. Inputs of type `text` generate an `input` event on every keystroke, but only generate a `change` event when focus is lost.

#### Dataflow to DOM:

You can feed changes into the dataflow graph from HTML form inputs as follows:

```html
<span from-dataflow="validation_out"></span>
```

Here `validation_out` is the name of the node in the dataflow graph whose value should be written into the `<span>`. The node name must be a valid Javascript symbol name. (The `_out` suffix is just a convention to make the purpose of this dataflow node clear.)

To write changes to the DOM, simply push out a change using `set`:

```javascript
dataflow.set({ validation_out: "<b>Your input was invalid</b>" });
```

By default, the value of `validation_out` will be written to the `innerHTML` property of the element, unescaped. **Warning**, you must escape or sanitize your dataflow output value to prevent injection attacks if you use this mechanism.

If you want to write to an attribute of the element other than `innerHTML`, you can specify the attribute name to write to using a colon-delineated suffix after the dataflow node name.

```html
<input type="text" from-dataflow="classValue_out:class:className">

<input type="checkbox" checked="true" from-dataflow="boolValue_out:attr:checked">

<span class="warning" from-dataflow="vizValue_out:style:visibility"></span>
```

Then you can push to these values in the normal way:

```javascript
// Switches on (toggles if necessary) the class `className` in the `text` input.
// (for `:class:`, the value must be boolean)
dataflow.set({ classValue_out: true });

// Unchecks the checkbox by setting `checked="false"` on the `checkbox` input element
// (for `:attr:`, the value can be any valid value for the HTML attribute, here `checked`)
dataflow.set({ boolValue_out: false });

// Sets `visibility: hidden` in the CSS properties of the span
// (for `:style:`, the value can be any valid value for the named CSS property, here `visibility`)
dataflow.set({ vizValue_out: "hidden" });
```

#### Dataflow both to and from the DOM:

Both of the above mechanisms can be combined, so that state changes to an `input` element are propagated into an input in the dataflow graph, and any changes to an output of the dataflow graph trigger the state of the element to be updated.

```html
<input type="checkbox" id="acceptBox" checked="false"
        to-dataflow-on-input="acceptBoxChecked_in"
        from-dataflow="acceptBoxChecked_out:checked">
```

(This is not normally how you would make a checkbox uncheckable, but it illustrates the point.)

```javascript
// Uncheck the accept box if it is checked when uncheckable is true
function autoUncheckAcceptBox(acceptBoxChecked_in, uncheckable) {
    if (acceptBoxChecked_in && uncheckable) {
        dataflow.set({ acceptBoxChecked_out: false });
    }
}
```

## Author

Luke Hutchison ([@LH](https://twitter.com/lh) on Twitter)

