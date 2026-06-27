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

Can functions be public? I think so. Can't be temp.

---

Need to make start and end possibly null

---

Make function be able to be public/private. Assumed private

---

Everything at the root of a file should be invalidated. The space should be reserved for imports, functions, global stuff.

---