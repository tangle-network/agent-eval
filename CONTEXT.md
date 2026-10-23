# Evaluation vocabulary

**Treatment:** a deliberately assigned bundle identified by its immutable definition and tagged with every input layer it changes. A run or arm may carry several treatments. _Avoid:_ one treatment per layer, layer folder.

**Treatment layer:** Task, Model, Budget, Team, Roles, Tools, Memory, Process or Oversight. These tags describe changed inputs. _Avoid:_ using `FindingLayer` for treatment tags.

**Finding layer:** the level at which a claim holds, from event through lab, with meta for the instrument. It does not identify which inputs changed.

**Conditions:** population-linked, time-stamped observations of the environment and operator interventions under which evidence was collected. Unknown values are explicit; an empty observed steer list means no steers were observed.

**As assigned:** every seed in an independently supplied assignment roster, including absent observations and teams that did not form. Missing outcomes remain unknown.

**As formed:** only assigned seeds whose execution owner explicitly observed a formed team. The package consumes that verdict; the execution owner defines formation.
