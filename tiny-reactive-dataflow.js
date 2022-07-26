
// tiny-reactive-dataflow library, inspired by https://github.com/datavis-tech/topologica
// Author: Luke Hutchison
// Hosted at: https://github.com/lukehutch/tiny-reactive-dataflow
// License: MIT

// Note: This library depends upon Lodash -- https://lodash.com/

let DEBUG_DATAFLOW = false;

var STRIP_COMMENTS = /((\/\/.*$)|(\/\*[\s\S]*?\*\/))/mg;
var ARGUMENT_NAMES = /([^\s,]+)/g;
function getParamNames(func) {
  var fnStr = func.toString().replace(STRIP_COMMENTS, '');
  var result = fnStr.slice(fnStr.indexOf('(')+1, fnStr.indexOf(')')).match(ARGUMENT_NAMES);
  if(result === null)
     result = [];
  return result;
}

function newQueue() {
    const queue = {
        headIdx: 0,
        tailIdx: 0,
        elts: {},
        enqueue: (elt) => queue.elts[queue.tailIdx++] = elt,
        dequeue: () => {
            if (queue.headIdx == queue.tailIdx) {
                throw new Error("Queue is empty");
            }
            return queue.elts[queue.headIdx++];
        },
        size: () => queue.tailIdx - queue.headIdx,
        isEmpty: () => queue.tailIdx == queue.headIdx
    };
    return queue;
}

const dataflow = {
    nameToFn: new Map(),               // name -> function
    nodeToUpstreamNodes: new Map(),    // name -> list of names
    nodeToDownstreamNodes: new Map(),  // name -> list of names
    updateBatches: newQueue(),         // queue of {name: value} objects
    value: {},                         // name -> value (as Object) -- read this for cached values
    valueChanged: {},                  // name -> boolean
    inProgress: false,
    errors: [],
    
    register: function(...fns) {
        const register = (fn, fnName) => {
            if (!(fn instanceof Function)) {
                throw new Error("Parameter is not a function: " + fn);
            }
            if (dataflow.nameToFn.has(fnName)) {
                throw new Error("Function is already registered: " + fnName);
            }
            
            // Index functions by name (these are the node names)
            dataflow.nameToFn.set(fnName, fn);

            // Extract param names from function (these are the upstream dep names)
            const paramNames = getParamNames(fn);
            
            // Create DAG
            dataflow.nodeToUpstreamNodes.set(fnName, paramNames);
            for (const usName of paramNames) {
                var dsFns = dataflow.nodeToDownstreamNodes.get(usName);
                if (!dsFns) {
                    dataflow.nodeToDownstreamNodes.set(usName, dsFns = []);
                }
                dsFns.push(fnName);
            }
        };
        if (arguments.length == 1
                && typeof arguments[0] === 'object' && !Array.isArray(arguments[0])) {
            // Accept registration in the form of `dataflow.register({ a: (b, c) => b + c })`
            for (const [fnName, fn] of Object.entries(arguments[0])) {
                register(fn, fnName);
            }
        } else {
            // Accept registration as a list of named functions: `dataflow.register(a, b, c)`
            for (const fn of fns) {
                register(fn, fn.name);
            }
        }
    },

    set: async function(nameToValuesObj) {
        // Visit a node and its transitive closure
        const visitNode = (name, visited, visitedInPath, fnVisitor) => {
            if (visitedInPath.has(name)) {
                throw new Error("Cycle detected, consisting of nodes: " + visitedInPath);
            }
            visitedInPath.add(name);
            if (!visited.has(name)) {
                visited.add(name);
                // Visit downstream functions of node recursively
                const dsFnNames = dataflow.nodeToDownstreamNodes.get(name);
                if (dsFnNames) {
                    for (const dsFnName of dsFnNames) {
                        const dsFn = dataflow.nameToFn.get(dsFnName);
                        // Call visitor lambda on function node
                        fnVisitor(dsFn);
                        // Recurse to function node
                        visitNode(dsFnName, visited, visitedInPath, fnVisitor);
                    }
                }
            }
            visitedInPath.delete(name);
        };
        // Visit the downstream transisive closure starting from a list of param names
        const visitReachableFnsFromParams = (paramNames, fnVisitor) => {
            const visited = new Set();
            const visitedInPath = new Set();
            for (const paramName of paramNames) {
                visitNode(paramName, visited, visitedInPath, fnVisitor);
            }
        }
        // Update the value of a node, and propagate any change downstream
        const setNodeValue = (name, value, dirtyNodeNamesOut) => {
            // Only propagate value if it changed
            const oldValue = dataflow.value[name];
            // Uses Lodash -- https://lodash.com/docs#isEqual
            const valueChanged = !_.isEqual(oldValue, value);
            dataflow.valueChanged[name] = valueChanged;
            if (valueChanged) {
                if (DEBUG_DATAFLOW) {
                    console.log("Setting:", {[name]: value});
                }
                dataflow.value[name] = value;
            }
            // Add names of direct downstream nodes to the dirtyNodeNamesOut set
            const dsFnNames = dataflow.nodeToDownstreamNodes.get(name);
            if (dsFnNames) {
                dsFnNames.forEach(dsFnName => {
                    const dsFn = dataflow.nameToFn.get(dsFnName);
                    if (--dsFn.numDirtyDeps == 0) {
                        // The current node is the last dependency of the downstream node that
                        // needs updating, so the downstream node can be updated
                        dirtyNodeNamesOut.add(dsFnName);
                    }
                });
            }
        }

        // Changes need to be scheduled, so that code running inside a node's function can call set.
        // If set is called while a node's function is running, the update will be only be run after
        // the current complete dataflow update has completed.
        // This allows for dynamic dataflow, in batched mode.
        dataflow.updateBatches.enqueue(nameToValuesObj);
        
        // Don't process the updateBatches queue if there is already a Promise processing these batches
        if (!dataflow.inProgress) {
            dataflow.inProgress = true;

            // Clear the `errors` field at the beginning of batch processing
            dataflow.errors = [];

            // Continue running batches until there are none left (batches can be dynamically added)
            while (!dataflow.updateBatches.isEmpty()) {
                const updateBatch = dataflow.updateBatches.dequeue();
                
                // Find the downstream transitive closure from all nodes reachable from the nodes listed
                // in updateBatch, and count the number of dirty upstream dependencies for each node
                for (const fn of dataflow.nameToFn.values()) {
                    fn.numDirtyDeps = 0;
                }
                visitReachableFnsFromParams(Object.keys(updateBatch), (fn) => fn.numDirtyDeps++);

                // Mark all values as unchanged
                dataflow.valueChanged = {};

                // Set the values of the nodes named in updateBatch, creating the initial dirty set of
                // direct downstream dependencies
                var dirtyNodeNames = new Set();
                for (const [name, value] of Object.entries(updateBatch)) {
                    setNodeValue(name, value, dirtyNodeNames);
                }

                // Propagate changes until all nodes in the transitive closure have been updated
                while (dirtyNodeNames.size > 0) {
                    // Schedule and await all pending function calls.
                    // For all (async) functions corresponding to dirty nodes,
                    // fetch the cached value for all upstream deps (i.e. all params),
                    // call the function, and collect the resulting promise.
                    const promises = [];
                    const fnNames = [];
                    const fnArgs = [];
                    for (const name of dirtyNodeNames) {
                        // Get the named function
                        const fn = dataflow.nameToFn.get(name);
                        // Get cached upstream node values for each parameter of fn
                        const args = [];
                        const paramNames = dataflow.nodeToUpstreamNodes.get(name);
                        let someArgChanged = false;
                        const paramNamesAndArgs = DEBUG_DATAFLOW ? {} : undefined;
                        for (const paramName of paramNames) {
                            if (dataflow.valueChanged[paramName]) {
                                someArgChanged = true;
                            }
                            const arg = dataflow.value[paramName];
                            args.push(arg);
                            if (DEBUG_DATAFLOW) {
                                paramNamesAndArgs[paramName] = arg;
                            }
                        }
                        fnNames.push(fn.name);
                        fnArgs.push(args);
                        if (someArgChanged) {
                            // Only call fn if at least one param value changed, to avoid repeating work
                            // (i.e. implement memoization)
                            if (DEBUG_DATAFLOW) {
                                console.log("Calling:", {[name]: paramNamesAndArgs});
                            }
                            // Call fn with these params, returning the resulting promise
                            promises.push(fn(...args));
                        } else {
                            // Otherwise reuse cached val (we still need to propagate unchanged
                            // value down dataflow graph, so that fn.numDirtyDeps gets correctly
                            // decremented all the way down the transitive closure).
                            promises.push(Promise.resolve(dataflow.value[name]));
                        }
                    }

                    // Clear the dirty nodes list to prep for the next stage of wavefront propagation
                    dirtyNodeNames.clear();
                    
                    // Wait for all promises to be resolved, yielding maximal concurrency
                    const promiseResults = await Promise.allSettled(promises);
                    for (var i = 0; i < fnNames.length; i++) {
                        const promiseResult = promiseResults[i];
                        if (promiseResult.status === "fulfilled") {
                            // Cache successful function call results
                            setNodeValue(fnNames[i], promiseResult.value, dirtyNodeNames);
                        } else if (promiseResult.status === "rejected") {
                            // Log errors
                            const errInfo = { functionName: fnNames[i], functionParams: fnArgs[i],
                                reason: promiseResult.reason};
                            console.log("Error executing dataflow node function:", errInfo);
                            dataflow.errors.push(errInfo);
                        } else {
                            console.log("Unknown promise result", promiseResult);
                        }
                    }
                }
                if (DEBUG_DATAFLOW && !dataflow.updateBatches.isEmpty()) {
                    console.log("Starting next dynamic dataflow batch");
                }
            }
            dataflow.inProgress = false;
            if (DEBUG_DATAFLOW) {
                console.log("Dataflow ended");
            }
        }
    },
    
    connectToDOM: () => {
        const validName = /^[A-Z_$][0-9A-Z_$]*$/i;
                
        // dataflow to DOM:
        // Register dataflow functions to push values back out to the DOM when there are changes.
        const functionsToRegister = [];
        let idIdx = 0;
        [...document.querySelectorAll("[from-dataflow]")].forEach(elt => {
            const dataflowAttrVal = elt.getAttribute("from-dataflow");
            const parts = dataflowAttrVal.split(":");
            const dataflowOutputNodeName = parts[0];
            if (!dataflowOutputNodeName || !validName.test(dataflowOutputNodeName)) {
                throw new Error("from-dataflow attribute does not specify a valid dataflow node name: "
                        + elt.outerHTML);
            }
            // Set innerHTML if no attribute is specified
            const targetAttrName = parts.length > 1 ? parts[1] : "innerHTML";
            // elt will be captured from this context when eval is called below
            const setter = "elt." + targetAttrName + " = "
                    + dataflowOutputNodeName + " === undefined ? '' : " + dataflowOutputNodeName + ";";
            // Create unique function name
            const functionName = "setDOM_" + idIdx++;
            // eval is the only way to create functions with both dynamic function names and dynamic parameter names
            eval("async function " + functionName + "(" + dataflowOutputNodeName + ") { " + setter + "; }");
            const fn = eval(functionName);
            functionsToRegister.push(fn);
        });
        // Register DOM update functions
        dataflow.register(...functionsToRegister);
        
        // DOM to dataflow:
        // Add change listeners to input elements in DOM that will push changes into the dataflow graph.
        // <input> elements should have class="dataflow-on-change" or class="dataflow-on-input", and
        // id="dataflowNodeName" (where dataflowNodeName needs to be a valid JS identifier).
        const getInputValue = (elt) => elt.type === "checkbox" || elt.type === "radio" ? elt.checked : elt.value;
        const initialValues = {};
        const registerListeners = (eventName) =>
            [...document.querySelectorAll("[to-dataflow-on-" + eventName + "]")].forEach(elt => {
                if (elt.tagName.toLowerCase() !== "input") {
                    throw new Error("Element with to-dataflow-on-change attribute is not an input element: "
                            + elt.outerHTML);
                }
                const dataflowAttrVal = elt.getAttribute("to-dataflow-on-" + eventName);
                if (!validName.test(dataflowAttrVal)) {
                    throw new Error("to-dataflow-on-" + eventName
                            + " attribute does not specify a valid dataflow node name: " + elt.outerHTML);
                }
                elt.addEventListener(eventName, () => dataflow.set({ [dataflowAttrVal]: getInputValue(elt) }));
                initialValues[elt.id] = getInputValue(elt);
            });
        registerListeners("change");
        registerListeners("input");
        // Seed dataflow graph with initial values from DOM
        dataflow.set(initialValues);
    },
};

