# A Dev Talks to Himself as He Builds

## 1. Semantic Analysis Planning
Currently trying to think about how best to implement semantic analysis. I can't lie, I am just getting back into this project, so I am rediscovering what I had previously written.
I guess I have to start at the beginning. What is semantic analysis? 
1. Type Checking
    * Operations need to be with compatible data types
    * One note to myself here is that I have reserved functions because it's Scratch, so those need to have a designed store for their types
2. Scope Resolution
    * Make sure variables and functions are designed in the right parts of code
    * I think this will cover imports too, but its worth thinking about
    * Undeclared and redeclared variable checks
3. Function Call Validation
    * I'll have to go back and check if I accidentally covered that in the parser, but I believe this should go here
4. Flow Control
    * Switch case validations, make sure fall through keywords and default cases etc. are all in valid places
5. Reserved Keyword
    * Check if variable and functions defined are conflicting with Katnip's

---

First I'm going to do symbol collection and scope resolution.
One important nuance I discovered was whether or not to enforce scope declaration. Should there be an inferred scope?
In Scratch, this inferred scope is mostly 'Public', as variables are shared across sprites. However, I think I am going to flip this, as it feels wrong to teach the user that variables work across sprites.

---

Thought dump:
* 'Private' kward can't be used at root level (stage). Can't be used as modifier for sprite either, tho neither should any modifier.
* Scope-less definitions are okay. Scratch does this, just opposite of me.
* I am going to raise function declarations so that they can be referenced before making. Requires 2 passes, but seems simpler and more intuitive in my opinion.
* I am going to allow function overloading. It seems useful, and I like the way Java does it.

## 2. Building Semantic Analysis

This will be shorter, since most of what I say is better just written in code.
The main idea is two passes:
1. Hoist
Bring procedures to the top to allow forward references. I explain why I did so above.
2. Visit
Acctually go through and validate. This is the main core bit of the semantic analysis portion.

---

I am a little stuck at a desgin fork. Should I allow scripts inside no 'Sprite' Scope to be there? Or should I force them into the Stage. Or do I error?
Scratch-like behaviors tell me that it should go to stage, but that feels tacky and wrong.

---

Can functions be public? I think so. Can't be temp. By making them public, I am allowing them to imported into other sprites. I suppose having functions be public and at the root of the file also works.
I'll allow a declarations of symbols, import statements, and sprite declarations at the root node of a file. This way files can act as libraries, but can't have random onFlag code sitting in them.
The space should be reserved for global stuff.

---

Need to make start and end possibly null on index slicing. Currently both are required, but I like the syntax that does `[:4]` or similar.

---

Make function be able to be public/private. Assumed private. That way they just stay part of the sprite and don't bloat the project. If the user wants them public, they can export/make them global.

---

Everything at the root of a file should be invalidated. The space should be reserved for imports, functions, global stuff.

---

NOTE: I should probably add a more intensive, fleshed out checker for return types and paths to the semantic analysis. Follow all branches and routes. 

## 3. Semantic analysis: types
binop:
If +
    If str is one of the types
        return str
    else 


nestedList?

stdlib for katnip will predom use guard clauses instead of early `stop [this script]` blocks, because I was told they slow the function down some how? Even if negligeable, it adds up I suppose so its prob best to estbalish that style

compiler flag for using minimal-vars or readable-vars, bc temp or iter vars can be re-used if calculated right

break/return inside for loop? how to use guard-clauses? or save enough time to stop this script? wbt continue?

## 4. IR: Planning

### Return statements
1. Single value 
    a. Single var return (naive)
    b. Add to list and read the last of list
2. Multi value
    a. Static signle return in list (chunk by size of return)
    b. Heap + pointers for dynamic size returns

### Lowering types for functions (expanding return statements section)
1. `@lower = "command"` -> emmitted in place
2. `@lower = "yields"` -> emit code above, then substitutes itself as input
3. `@lower = "userproc"` -> return statements
4. `@lower = "builds"` -> heap filling loop, yields a handle, leaves to codegen
5. `@lower = "reporter"` -> native reporter

### Unstructured yap
I have now organized the IR into a few main core pieces:
* Expression pieces: literals, operators, parameters, variables, and stack referrences (for function returns)
* Statement pieces: raw (standard) scratch blocks, func calls, set/push/pop, if/while/forever/for/

---

Talked with a friend. Raw is the best way to go, so I removed the set/push/pop, leaving if/while/forever/for/forever since those are split prior to IR already. 

---

Also important decision regarding stdlib: definitions exist both in `/stdlib/` but also have definitions in `/codegen/` so that metadata is stored both for the katnip syntax, but also for the compiler itself. This split is cleaner that forcing the katnip syntax to match the metadata needs of the compiler.

The one thing that did take a change in favor of compiler metadata was the ability for enums to have a different value than just their name. 

---

Working on scratchDefs rn, I made a pretty nice construct to store all the metadata for scratch. I'm debating adding specfic input types per each input scratch type.
Unsure whether or not to accomodate for this in the codegen or ts definitions files.

---

readcallbacks for imports? seems to be best way; let user define how imports are handled so cli and web both work
Imports should probably include an `import { x } from "package.knip";` funcitonality, but thats a good TODO for later.
- Also worth noting that circular import error msgs are a bit big--error msgs don't know where they're from
- Multi-file diagnostics don't exactly work. Currently a note appears on the import line, instead of erroring on the file

---

```
struct Blob {
  x: num,
  y: num,
  name: str
}

allBlobs: list<Blob> = []

for (i, range(10)) {
  allBlobs.add({ i, i**2, f"jared {i}" });
}
```

what should this store? a list per piece of a blob? or a single list that has blobs of chunk size 3

built both of them in scratch, and the parallel lists is such a better approach. It just gets so much of the reading done for much less code.

### IR Internals

Looking through, one thing I need to handle correctly is mangling of procs. Since a user could overload a function with the same amount/types of inputs and the same name. Scratch doesn't allow this, and will just go with the first def. So I have to deliniate which proc is which overload.

Going to stick with `procName-1 (input) <input>`, `procName-2 (input) <input>` etc etc for now. I will probably add a better way to denote wich one is which, but for now, this will do.

Following the same track of thinking, parsing procs are a little weird. Because I have overloading, as well as the complexity of different return methods, I need to put extra thought into this part. The return methods require boilerplate, and depend largely on what the content of the proc is. So I think I have to hoist that first into a metadata store or som.

---

whats the best way to impl default values for arugments in procs in scratch? 
Should katnip pre-compile them to be present in the actual call block itself?
Or should it be a runtime check (slower, but *maybe* cleaner) that checks for empty values

Oops that had an easy answer. Def the first. I would need extra vars and bloat and boilerplate to pull the latter off. Maybe a better solution will come later, but this is by far the best.

---

Returning values via var method with a tuple (multi-value) return type is interesting. I need to omit a stack above it, but also check to see if things have been nested alongside each other. Thats where the offset comes in handy for vstack method.

---

2 systems
    a. temp vars -> storage
    b. returns -> ABI
Don't share lists

TODO: actually implement temps. Its a lot more complicated than a key-value list. Var mangling or a stack or other methods are better. Lots to think through, and a lil overwhelmed with the scale atm.

---

Potential issue with stacks: if procs are atmoic (run without screen refresh), theres potential for a proc to yield mid-body, and have a false row read.