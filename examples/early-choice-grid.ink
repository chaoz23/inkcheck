VAR one = false
VAR two = false
VAR three = false
VAR four = false
VAR five = false
VAR six = false
VAR seven = false
VAR eight = false
VAR nine = false

-> c1

=== c1 ===
* [1-1]
    ~ one = true
    -> c2
* [1-2]
    ~ two = true
    -> c2
* [1-3]
    ~ three = true
    -> c2

=== c2 ===
* [2-1]
    ~ four = true
    -> c3
* [2-2]
    ~ five = true
    -> c3
* [2-3]
    ~ six = true
    -> c3

=== c3 ===
* [3-1]
    ~ seven = true
    -> c4
* [3-2]
    ~ eight = true
    -> c4
* [3-3]
    ~ nine = true
    -> c4

=== c4 ===
* [4-1] -> c5
* [4-2] -> c5
* [4-3] -> c5

=== c5 ===
* [5-1] -> c6
* [5-2] -> c6
* [5-3] -> c6

=== c6 ===
* [6-1] -> c7
* [6-2] -> c7
* [6-3] -> c7

=== c7 ===
* [7-1] -> c8
* [7-2] -> c8
* [7-3] -> c8

=== c8 ===
* [8-1] -> c9
* [8-2] -> c9
* [8-3] -> c9

=== c9 ===
* [9-1] -> c10
* [9-2] -> c10
* [9-3] -> c10

=== c10 ===
* [10-1] -> c11
* [10-2] -> c11
* [10-3] -> c11

=== c11 ===
* [11-1] -> c12
* [11-2] -> c12
* [11-3] -> c12

=== c12 ===
* [12-1] -> c13
* [12-2] -> c13
* [12-3] -> c13

=== c13 ===
* [13-1] -> c14
* [13-2] -> c14
* [13-3] -> c14

=== c14 ===
* [14-1] -> c15
* [14-2] -> c15
* [14-3] -> c15

=== c15 ===
* [15-1] -> ending1
* {one && four} [15-2] -> ending2
* {one && five} [15-3] -> ending3
* {one && six} [15-4] -> ending4
* {one && seven} [15-5] -> ending5
* {one && eight} [15-6] -> ending6
* {one && nine} [15-7] -> ending7

=== ending1 ===
Ending 1
-> END

=== ending2 ===
Ending 2
-> END

=== ending3 ===
Ending 3
-> END

=== ending4 ===
Ending 4
-> END

=== ending5 ===
Ending 5
-> END

=== ending6 ===
Ending 6
-> END

=== ending7 ===
Ending 7
-> END
